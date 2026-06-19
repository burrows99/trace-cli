import { CdpDriver } from "../transport/CdpDriver.js";
import { TargetKind } from "../domain/Target.js";
import type { LaunchedChrome } from "./ChromeLauncher.js";

/**
 * ChromeSession — the bridge between a Chrome we hold (launched or attached) and the CDP transport that talks
 * to it. One object per `--chrome` run: it carries the port, knows whether it OWNS the browser process — so
 * teardown is real for a throwaway we launched and a no-op for an attached, user-owned window — and exposes the
 * Chrome-flavoured target discovery (the `/json` page-target semantics) so callers never reach into CdpDriver's
 * Chrome branch by hand. Process lifecycle (spawn/profile/kill) is {@link ChromeLauncher}'s; the raw websocket
 * connect stays {@link CdpDriver}'s (shared with Node). This sits between the two — neither owns the other.
 */
export class ChromeSession {
  constructor(readonly port: number, private readonly owned: LaunchedChrome | null = null) {}

  /** True when we launched this Chrome (so we tear it down); false for an attached, user-owned browser. */
  get launched(): boolean { return this.owned !== null; }

  /** The open page targets (type "page" with a websocket) — used to spot our freshly-opened tab (and popups). */
  async pageTargets(): Promise<any[]> {
    return (await CdpDriver.listTargets(this.port, TargetKind.Chrome)).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  }

  /** Open a fresh blank tab (for a debug Chrome that's up but tabless) and return its descriptor. */
  openBlankTab(): Promise<any> {
    return CdpDriver.createPageTarget(this.port);
  }

  /** Stop the browser if WE launched it; a no-op for an attached session — the user owns that window. */
  kill(): void { this.owned?.kill(); }
}
