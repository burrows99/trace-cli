import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sleep } from "../shared/sleep.js";
import { logger } from "../shared/logger.js";
import { Code } from "../shared/codes.js";
import { ChromeSession } from "./ChromeSession.js";

const log = logger.child({ component: "chrome" });

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter(Boolean) as string[];

/** Resolve a Chrome/Chromium binary (env CHROME_BIN first, then standard install paths), or null if none. */
export function chromeBinary(): string | null {
  return CHROME_CANDIDATES.find((candidatePath) => existsSync(candidatePath)) ?? null;
}

/** Ask the OS for a free TCP port (bind :0, read the assigned port, release it). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

/** A Chrome process we launched: its CDP port plus a kill() that stops the process and (if ours) removes its profile. */
export interface LaunchedChrome {
  port: number;
  kill(): void;
}

/**
 * How to get a Chrome to trace against. Exactly one of three modes, picked by which fields are set:
 * - attach: a `port` only → use a running browser's `--remote-debugging-port` as-is (a real, logged-in session).
 * - throwaway: `launch` → spawn a headless Chrome on a fresh temp profile, traced and torn down (the default).
 * - profile: `profileDir` → launch a (headed) Chrome on a persistent `--user-data-dir`, so saved logins/cookies
 *   carry over — the authenticated-session path. `launch` is implied. The profile dir is the caller's; we never
 *   delete it on teardown.
 */
export interface AcquireSpec {
  port?: number;          // attach target — a running --remote-debugging-port
  launch?: boolean;       // spawn a throwaway headless Chrome instead of attaching
  profileDir?: string;    // persistent --user-data-dir (a real, logged-in profile); implies a launched, headed Chrome
  headed?: boolean;       // launch visibly (default: headed when profileDir is set, else headless)
  extraArgs?: string[];   // extra Chrome flags (e.g. the recorder's --force-device-scale-factor)
  purpose?: string;       // log label only — distinguishes the trace target from the recorder's render Chrome
}

/** Internal spawn parameters, after {@link ChromeLauncher.acquire} has resolved a spec into a concrete launch. */
interface SpawnSpec {
  headless: boolean;
  userDataDir?: string;   // explicit, caller-owned profile; when absent a throwaway temp dir is created (and removed on kill)
  extraArgs: string[];
  purpose: string;
}

/**
 * ChromeLauncher — the single owner of Chrome process lifecycle: resolve the binary, spawn a browser (throwaway
 * headless on a temp profile, or headed on a persistent logged-in one), wait until its CDP endpoint answers, and
 * hand back a {@link ChromeSession} that bridges it to the transport. {@link acquire} is the one entry point — it
 * decides attach vs throwaway vs profile so callers never branch on launch mode themselves; the live trace target
 * (`trace run --chrome`) and the recorder's video renderer both come through here. Attach mode spawns nothing —
 * that's how a real, already-open session is traced.
 */
export class ChromeLauncher {
  /**
   * Resolve a spec into a {@link ChromeSession}: attach to a running browser, or launch one (throwaway, or on a
   * persistent profile) and own its teardown. A named `profileDir` implies launching and runs headed by default,
   * so saved logins are reused in a window you can see; a throwaway runs headless.
   */
  static async acquire(spec: AcquireSpec): Promise<ChromeSession> {
    // A persistent profile only makes sense if we launch the browser ourselves — you can't graft a profile onto
    // an already-running one — so naming a profileDir implies launch, just like bare `--chrome` does.
    const shouldLaunch = spec.launch || spec.profileDir != null;
    if (!shouldLaunch) {
      if (!spec.port) throw new Error("attach mode needs a Chrome --remote-debugging-port (pass --chrome <port>)");
      return ChromeLauncher.attach(spec.port);
    }
    const headed = spec.headed ?? spec.profileDir != null;
    const launched = await ChromeLauncher.#spawn({
      headless: !headed,
      ...(spec.profileDir != null ? { userDataDir: spec.profileDir } : {}),
      extraArgs: spec.extraArgs ?? [],
      purpose: spec.purpose ?? "trace target",
    });
    return new ChromeSession(launched.port, launched);
  }

  /** Wrap a running browser's debug port as a non-owning session (no spawn, kill is a no-op). */
  static attach(port: number): ChromeSession {
    return new ChromeSession(port, null);
  }

  /** Spawn a throwaway headless Chrome (temp profile, removed on kill). The low-level handle the recorder + tests use. */
  static launch(extraArgs: string[] = [], opts: { purpose?: string } = {}): Promise<LaunchedChrome> {
    return ChromeLauncher.#spawn({ headless: true, extraArgs, purpose: opts.purpose ?? "trace target" });
  }

  static async #spawn(spec: SpawnSpec): Promise<LaunchedChrome> {
    const binaryPath = chromeBinary();
    if (!binaryPath) throw new Error("no Chrome found to launch (set CHROME_BIN, or pass --chrome <port> to attach to a running one)");
    const port = await freePort();
    // A caller-supplied profileDir is the user's (their logins live there) — keep it. A temp profile is ours — sweep it.
    const ephemeralProfile = spec.userDataDir == null;
    const profile = spec.userDataDir ?? mkdtempSync(join(tmpdir(), "trace-chrome-profile-"));
    const cleanup = () => { if (ephemeralProfile) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } } };
    const chromeProcess = spawn(binaryPath, [
      ...(spec.headless ? ["--headless=new", "--disable-gpu", "--hide-scrollbars"] : []),
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check",
      ...spec.extraArgs, "about:blank",
    ], { stdio: "ignore" });
    chromeProcess.on("error", (error) => log.error("chrome launch failed", { code: Code.CHROME, bin: binaryPath, err: String(error) }));

    for (let attempt = 0; attempt < 80; attempt++) {
      try { await (await fetch(`http://localhost:${port}/json/version`)).json();
        log.info(`launched chrome (${spec.purpose})`, { port, purpose: spec.purpose, headless: spec.headless, profile: ephemeralProfile ? "throwaway" : profile });
        return { port, kill() { try { chromeProcess.kill("SIGKILL"); } catch { /* ignore */ } cleanup(); } };
      } catch { await sleep(100); }
    }
    try { chromeProcess.kill("SIGKILL"); } catch { /* ignore */ }
    cleanup();
    throw new Error(`launched Chrome did not expose its CDP endpoint on port ${port} within ~8s`);
  }
}
