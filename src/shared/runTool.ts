import { execFile } from "node:child_process";

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
 */
export function runTool(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<ToolRun> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024 },
      (err: any, stdout, stderr) => {
        const out = stdout?.toString() ?? "";
        const errOut = stderr?.toString() ?? "";
        if (!err) { resolve({ ok: true, stdout: out, stderr: errOut, code: 0 }); return; }
        // execFile sets err.code to the exit number for a non-zero exit, or a string (ENOENT/ETIMEDOUT) otherwise.
        const numericCode = typeof err.code === "number" ? err.code : null;
        const reason = err.code === "ENOENT" ? `${cmd} not found on PATH`
          : err.killed ? `${cmd} timed out`
          : (errOut.split("\n")[0] || String(err.message || err).split("\n")[0]);
        resolve({ ok: false, stdout: out, stderr: errOut, code: numericCode, error: reason });
      },
    );
  });
}
