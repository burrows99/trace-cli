import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sleep } from "../shared/sleep.js";
import { logger } from "../shared/logger.js";

const log = logger.child({ component: "chrome" });

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter(Boolean) as string[];

/** Resolve a Chrome/Chromium binary (env CHROME_BIN first, then standard install paths), or null if none. */
export function chromeBinary(): string | null {
  return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** Ask the OS for a free TCP port (bind :0, read the assigned port, release it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** A throwaway headless Chrome: its CDP port plus a kill() that stops the process and removes its profile. */
export interface LaunchedChrome {
  port: number;
  kill(): void;
}

/**
 * ChromeLauncher — spawn a throwaway headless Chrome on a free port with a temp profile, wait until its CDP
 * endpoint answers, and hand back the port plus a kill() that also cleans the profile. One launcher, two uses:
 * the live trace target (`trace dynamic --chrome` with no port) and the recording-video renderer — so a Chrome
 * trace is turnkey instead of requiring a hand-started browser. Attach mode (`--chrome <port>`) bypasses this
 * entirely, which is how you trace a real, already-open session.
 */
export class ChromeLauncher {
  static async launch(extraArgs: string[] = []): Promise<LaunchedChrome> {
    const bin = chromeBinary();
    if (!bin) throw new Error("no Chrome found to launch (set CHROME_BIN, or pass --chrome <port> to attach to a running one)");
    const port = await freePort();
    const profile = mkdtempSync(join(tmpdir(), "trace-chrome-profile-"));
    const cleanup = () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } };
    const proc = spawn(bin, [
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars",
      ...extraArgs, "about:blank",
    ], { stdio: "ignore" });
    proc.on("error", (e) => log.error("chrome launch failed", { bin, err: String(e) }));

    for (let i = 0; i < 80; i++) {
      try { await (await fetch(`http://localhost:${port}/json/version`)).json(); log.info("launched headless chrome", { port });
        return { port, kill() { try { proc.kill("SIGKILL"); } catch { /* ignore */ } cleanup(); } };
      } catch { await sleep(100); }
    }
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    cleanup();
    throw new Error(`launched Chrome did not expose its CDP endpoint on port ${port} within ~8s`);
  }
}
