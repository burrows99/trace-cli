import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ToolRun {
  ok: boolean;            // true when the tool exited 0
  stdout: string;
  stderr: string;
  exitCode: number | null;    // exit code, or null when the process never started / was killed
  error?: string;         // one-line reason when !ok (e.g. "madge not found on PATH")
}

/**
 * runTool — spawn a backing CLI tool, capture its output, and NEVER throw. A missing binary (ENOENT), a
 * timeout, or a non-zero exit all resolve to `{ ok: false, error }` so the calling command can turn the
 * failure into an error diagnostic on a still-well-formed Trace — the same "an agent always gets a Trace"
 * contract the run/graph commands honour. The shared seam for the static analyses (madge/lizard/tree-sitter).
 *
 * Output is captured to temp FILES, not pipes. A child that prints a large payload and then calls
 * `process.exit()` (madge does this) truncates piped stdout to the OS pipe buffer (~64KB on macOS) — the
 * classic Node gotcha — because async pipe writes are dropped at exit. Writing the child's stdout straight to
 * a regular file makes those writes blocking, so the full output survives regardless of size. We then read the
 * file back. stderr gets the same treatment; both temp files are always cleaned up.
 */
export function runTool(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {}, // maxBuffer kept for API compatibility; unused (file-backed capture is unbounded)
): Promise<ToolRun> {
  return new Promise((resolve) => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "trace-tool-"));
    const stdoutPath = join(tempDirectory, "stdout");
    const stderrPath = join(tempDirectory, "stderr");
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");

    let settled = false;
    let timedOut = false;

    // Single finalization: close the fds, read both captures back, remove the temp dir, resolve exactly once.
    const finalize = (build: (stdout: string, stderr: string) => Omit<ToolRun, "stdout" | "stderr">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const fd of [stdoutFd, stderrFd]) { try { closeSync(fd); } catch { /* already closed */ } }
      let stdout = "", stderr = "";
      try { stdout = readFileSync(stdoutPath, "utf8"); } catch { /* never written */ }
      try { stderr = readFileSync(stderrPath, "utf8"); } catch { /* never written */ }
      try { rmSync(tempDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
      const result = build(stdout, stderr);
      resolve({ ...result, stdout, stderr });
    };

    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", stdoutFd, stderrFd] });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 60_000);

    child.on("error", (error: NodeJS.ErrnoException) => finalize(() => ({
      ok: false,
      exitCode: null,
      error: error.code === "ENOENT" ? `${command} not found on PATH` : String(error.message || error).split("\n")[0],
    })));

    child.on("close", (exitCode, signal) => finalize((_stdout, stderr) => {
      if (timedOut) return { ok: false, exitCode: null, error: `${command} timed out` };
      if (exitCode === 0) return { ok: true, exitCode: 0 };
      const reason = stderr.split("\n").find(Boolean) || (signal ? `${command} killed by ${signal}` : `${command} exited ${exitCode}`);
      return { ok: false, exitCode: exitCode ?? null, error: reason };
    }));
  });
}
