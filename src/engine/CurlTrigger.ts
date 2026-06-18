import { exec } from "node:child_process";

export interface CurlResult { exitCode: number; body?: string; stderr?: string; error?: string; }

/**
 * CurlTrigger — runs a curl command as the Node trace trigger and normalizes its result (exit code + bounded
 * stdout/stderr, "timeout" when killed). SRP: subprocess execution + output capture only; the Tracer decides
 * when to fire it and what to do with the result.
 */
export class CurlTrigger {
  static run(command: string, timeoutMs: number): Promise<CurlResult> {
    return new Promise((resolve) => {
      exec(command, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error: any, stdout, stderr) => {
        resolve({ exitCode: error?.code ?? 0, body: String(stdout || "").slice(0, 1500), stderr: String(stderr || "").slice(0, 500) || undefined, error: error?.killed ? "timeout" : undefined });
      });
    });
  }
}
