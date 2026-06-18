import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ToolRun {
  ok: boolean;            // true when the tool exited 0
  stdout: string;
  stderr: string;
  code: number | null;    // exit code, or null when the process never started / was killed
  error?: string;         // one-line reason when !ok (e.g. "madge not found on PATH")
}

/**
 * runTool — spawn a backing CLI tool, capture its output, and NEVER throw. A missing binary (ENOENT), a
 * timeout, or a non-zero exit all resolve to `{ ok: false, error }` so the calling command can turn the
 * failure into an error diagnostic on a still-well-formed Trace — the same "an agent always gets a Trace"
 * contract the dynamic/graph commands honour. The shared seam for the static analyses (madge/lizard/tree-sitter).
 *
 * Output is captured to temp FILES, not pipes. A child that prints a large payload and then calls
 * `process.exit()` (madge does this) truncates piped stdout to the OS pipe buffer (~64KB on macOS) — the
 * classic Node gotcha — because async pipe writes are dropped at exit. Writing the child's stdout straight to
 * a regular file makes those writes blocking, so the full output survives regardless of size. We then read the
 * file back. stderr gets the same treatment; both temp files are always cleaned up.
 */
export function runTool(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}, // maxBuffer kept for API compatibility; unused (file-backed capture is unbounded)
): Promise<ToolRun> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "trace-tool-"));
    const outPath = join(dir, "stdout");
    const errPath = join(dir, "stderr");
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");

    let settled = false;
    let timedOut = false;

    // Single finalization: close the fds, read both captures back, remove the temp dir, resolve exactly once.
    const finalize = (build: (out: string, err: string) => Omit<ToolRun, "stdout" | "stderr">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const fd of [outFd, errFd]) { try { closeSync(fd); } catch { /* already closed */ } }
      let stdout = "", stderr = "";
      try { stdout = readFileSync(outPath, "utf8"); } catch { /* never written */ }
      try { stderr = readFileSync(errPath, "utf8"); } catch { /* never written */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      const r = build(stdout, stderr);
      resolve({ ...r, stdout, stderr });
    };

    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", outFd, errFd] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs ?? 60_000);

    child.on("error", (err: NodeJS.ErrnoException) => finalize(() => ({
      ok: false,
      code: null,
      error: err.code === "ENOENT" ? `${cmd} not found on PATH` : String(err.message || err).split("\n")[0],
    })));

    child.on("close", (code, signal) => finalize((_out, stderr) => {
      if (timedOut) return { ok: false, code: null, error: `${cmd} timed out` };
      if (code === 0) return { ok: true, code: 0 };
      const reason = stderr.split("\n").find(Boolean) || (signal ? `${cmd} killed by ${signal}` : `${cmd} exited ${code}`);
      return { ok: false, code: code ?? null, error: reason };
    }));
  });
}
