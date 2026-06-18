import { performance } from "node:perf_hooks";

import { CdpDriver } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { SourceMaps } from "./SourceMaps.js";
import { BpBinder } from "./BpBinder.js";
import { EventCapturer, type CdpCtx } from "./EventCapturer.js";
import { Breakpoint } from "../domain/Breakpoint.js";
import type { TraceConfig, TracedHit } from "./JourneyRunner.js";

/**
 * TabTracer — breakpoint tracing for ONE page target. Arms the tab the way the Tracer does (an optional
 * instrumentation pause so a breakpoint binds before a freshly-opened tab's first run), captures every pause
 * as a TraceEvent stamped with wall-clock time, and re-binds after navigations as new chunks parse. Hits land
 * in the shared `hits` array, so the journey-wide `maxHits` cap and the cross-tab report both see one stream.
 */
export class TabTracer {
  #driver: CdpDriver;
  #cfg: TraceConfig;
  #hits: TracedHit[];
  #binder: BpBinder;
  #sm: SourceMaps;
  #capturer: EventCapturer;
  #ctx: CdpCtx;
  #instrId: string | null = null;
  #loaded = false;

  constructor(driver: CdpDriver, cfg: TraceConfig, hits: TracedHit[]) {
    this.#driver = driver;
    this.#cfg = cfg;
    this.#hits = hits;
    this.#binder = new BpBinder(cfg.bps);
    this.#sm = new SourceMaps(driver, cfg.root);
    this.#capturer = new EventCapturer(driver);
    this.#ctx = { t0: performance.now(), events: [], frames: cfg.frames, exprs: cfg.exprs, steps: [], sm: this.#sm, bpById: this.#binder.bpById };
  }

  /**
   * Enable the debugger, optionally instrument first-run (needed for a freshly-opened tab whose code runs once
   * on load), wire the pause handler, and bind what we can now. `instrument` is false for an already-live tab
   * (e.g. Pulse, where the handler fires later on click) — we just bind and re-bind after each navigation.
   */
  async arm(instrument: boolean): Promise<void> {
    this.#driver.on(Cdp.Page.loadEventFired, () => { this.#loaded = true; });
    await this.#driver.send(Cdp.Debugger.enable).catch(() => {});
    await this.#driver.send(Cdp.Debugger.setPauseOnExceptions, { state: "none" }).catch(() => {});
    if (instrument) {
      const r = await this.#driver.send(Cdp.Debugger.setInstrumentationBreakpoint, { instrumentation: "beforeScriptExecution" }).catch(() => null);
      this.#instrId = r?.breakpointId ?? null;
    }
    this.#driver.on(Cdp.Debugger.paused, (p: any) => { void this.#onPause(p); });
    await this.#binder.tryBind(this.#driver, this.#sm);
  }

  /** Re-bind after a navigation — newly-parsed chunks may carry a previously-unbound breakpoint. */
  async reBind(): Promise<void> {
    await this.#binder.tryBind(this.#driver, this.#sm).catch(() => {});
  }

  /** This tab's breakpoint-binding report (bound/unbound per breakpoint). */
  report(): Breakpoint[] {
    return this.#binder.report();
  }

  async #onPause(paused: any): Promise<void> {
    try {
      const cap = this.#hits.length < this.#cfg.maxHits;
      if (paused.reason === "instrumentation") {
        // A script is about to run for the first time — bind any breakpoints it carries, then drop the
        // instrumentation pause once everything's bound (or the page loaded, or we've hit the cap).
        if (cap && !this.#binder.allSettled()) await this.#binder.tryBind(this.#driver, this.#sm);
        if ((this.#binder.allSettled() || this.#loaded || !cap) && this.#instrId) {
          const id = this.#instrId; this.#instrId = null;
          await this.#driver.send(Cdp.Debugger.removeBreakpoint, { breakpointId: id }).catch(() => {});
        }
      } else if (cap) {
        const ev = await this.#capturer.capture(paused, "breakpoint", this.#ctx);
        this.#ctx.events.push(ev);
        this.#hits.push({ ev, t: Date.now() });
        // Stream the cross-tab event list so far (same shape traceChrome returns) for live collector updates.
        this.#cfg.onEvent?.(this.#hits.map((h) => h.ev));
      }
    } catch { /* keep the journey moving even if a capture fails */ }
    await this.#driver.send(Cdp.Debugger.resume).catch(() => {});
  }
}
