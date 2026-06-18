import { performance } from "node:perf_hooks";

import { CdpDriver } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { SourceMaps } from "./SourceMaps.js";
import { BpBinder } from "./BpBinder.js";
import { BINDING_NAME, HELPER_SOURCE, LogpointCapturer } from "./Logpoint.js";
import { Breakpoint } from "../domain/Breakpoint.js";
import type { TraceConfig, TracedHit } from "./JourneyRunner.js";

/**
 * TabTracer — non-pausing breakpoint tracing for ONE page target. It arms logpoints (a breakpoint whose
 * condition captures stack/locals/exprs and ships them out without halting the VM), so the page runs at full
 * speed and the journey is never frozen mid-gesture. The only real pause it still uses is the optional
 * `beforeScriptExecution` instrumentation pause — purely to *bind* a breakpoint before a freshly-opened tab's
 * first-run code executes; logpoint hits themselves never reach {@link #onPause}. Hits land in the shared
 * `hits` array, so the journey-wide `maxHits` cap and the cross-tab report both see one stream.
 */
export class TabTracer {
  #driver: CdpDriver;
  #cfg: TraceConfig;
  #hits: TracedHit[];
  #binder: BpBinder;
  #sm: SourceMaps;
  #capturer: LogpointCapturer;
  #events: import("../domain/TraceEvent.js").TraceEvent[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  #instrId: string | null = null;
  #loaded = false;

  constructor(driver: CdpDriver, cfg: TraceConfig, hits: TracedHit[]) {
    this.#driver = driver;
    this.#cfg = cfg;
    this.#hits = hits;
    this.#binder = new BpBinder(cfg.bps, cfg.exprs);
    this.#sm = new SourceMaps(driver, cfg.root);
    this.#capturer = new LogpointCapturer(driver, this.#sm, performance.now(), cfg.frames);
  }

  /**
   * Enable the debugger, install the logpoint transport (the emit binding + the per-document serializer),
   * optionally instrument first-run so a breakpoint binds before on-load code runs, wire the binding +
   * instrumentation handlers, and bind what we can now. `instrument` is false for an already-live tab.
   */
  async arm(instrument: boolean): Promise<void> {
    this.#driver.on(Cdp.Page.loadEventFired, () => { this.#loaded = true; });
    await this.#driver.send(Cdp.Debugger.enable).catch(() => {});
    await this.#driver.send(Cdp.Debugger.setPauseOnExceptions, { state: "none" }).catch(() => {});
    await this.#driver.send(Cdp.Runtime.addBinding, { name: BINDING_NAME }).catch(() => {});
    await this.#driver.send(Cdp.Runtime.evaluate, { expression: HELPER_SOURCE }).catch(() => {});
    // A navigation builds a fresh context where the serializer global is gone — re-install it per document.
    await this.#driver.send(Cdp.Page.addScriptToEvaluateOnNewDocument, { source: HELPER_SOURCE }).catch(() => {});
    this.#driver.on(Cdp.Runtime.bindingCalled, (e: any) => { if (e?.name === BINDING_NAME) this.#onHit(e.payload); });
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

  /** A logpoint fired. Serialize conversions (the stack resolve is async) so seq + ordering stay stable. */
  #onHit(payload: string): void {
    if (this.#hits.length >= this.#cfg.maxHits) return;
    this.#chain = this.#chain.then(async () => {
      if (this.#hits.length >= this.#cfg.maxHits) return;
      const ev = await this.#capturer.toEvent(payload, this.#events.length + 1).catch(() => null);
      if (!ev) return;
      this.#events.push(ev);
      this.#hits.push({ ev, t: Date.now() });
      this.#cfg.onEvent?.(this.#hits.map((h) => h.ev));
    });
  }

  /** Only the instrumentation pause reaches here now (logpoints don't pause); bind, then drop it once settled. */
  async #onPause(paused: any): Promise<void> {
    try {
      if (paused.reason !== "instrumentation") { await this.#driver.send(Cdp.Debugger.resume).catch(() => {}); return; }
      const cap = this.#hits.length < this.#cfg.maxHits;
      if (cap && !this.#binder.allSettled()) await this.#binder.tryBind(this.#driver, this.#sm);
      if ((this.#binder.allSettled() || this.#loaded || !cap) && this.#instrId) {
        const id = this.#instrId; this.#instrId = null;
        await this.#driver.send(Cdp.Debugger.removeBreakpoint, { breakpointId: id }).catch(() => {});
      }
    } catch { /* keep the journey moving */ }
    await this.#driver.send(Cdp.Debugger.resume).catch(() => {});
  }
}
