import { performance } from "node:perf_hooks";

import { CdpDriver } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { SourceMaps } from "./SourceMaps.js";
import { BreakpointBinder } from "./BreakpointBinder.js";
import { BINDING_NAME, HELPER_SOURCE, LogpointCapturer } from "./Logpoint.js";
import { Breakpoint } from "../domain/Breakpoint.js";
import type { TraceEvent } from "../domain/TraceEvent.js";
import type { TraceConfig, TracedHit } from "./JourneyRunner.js";

/**
 * TabTracer — non-pausing breakpoint tracing for ONE page target.
 *
 * ┌─ ⏸️  THE ONE PAUSE ────────────────────────────────────────────────────────────────────────────────────┐
 * │ trace-cli NEVER pauses on a breakpoint hit. Breakpoints are logpoints (see Logpoint.ts): a hit captures │
 * │ its stack/locals/exprs and continues, so the page is never frozen. There is exactly ONE place anything  │
 * │ halts the VM — the `beforeScriptExecution` instrumentation pause armed by {@link #armFirstRunBindPause}, │
 * │ and only when `bindBeforeFirstRun` is set. Its sole job is to BIND a breakpoint before a freshly-        │
 * │ navigated tab runs its first-run / on-mount code; it fires during binding, never on a hit, and removes  │
 * │ itself the moment binding settles. It is not optional: dropping it took on-mount capture from 3 hits to  │
 * │ 0 on the react-app fixture, because a source-mapped breakpoint cannot be placed before the script runs   │
 * │ without halting at parse time. If you ever observe a pause anywhere ELSE, that's a bug — not by design.  │
 * └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Hits land in the shared `hits` array, so the journey-wide `maxHits` cap and the cross-tab report see one stream.
 */
export class TabTracer {
  #driver: CdpDriver;
  #config: TraceConfig;
  #hits: TracedHit[];
  #binder: BreakpointBinder;
  #sourceMaps: SourceMaps;
  #capturer: LogpointCapturer;
  #events: TraceEvent[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  /** id of THE ONE PAUSE (the bind-before-first-run instrumentation breakpoint), or null when not armed/dropped. */
  #firstRunPauseId: string | null = null;
  #loaded = false;

  constructor(driver: CdpDriver, config: TraceConfig, hits: TracedHit[]) {
    this.#driver = driver;
    this.#config = config;
    this.#hits = hits;
    this.#binder = new BreakpointBinder(config.bps, config.exprs);
    this.#sourceMaps = new SourceMaps(driver, config.root);
    this.#capturer = new LogpointCapturer(driver, this.#sourceMaps, performance.now(), config.frames);
  }

  /**
   * Enable the debugger, install the logpoint transport (the emit binding + the per-document serializer), wire
   * the hit + pause handlers, and bind what's already parsed. `bindBeforeFirstRun` arms THE ONE PAUSE (see the
   * class doc) so a breakpoint binds before a freshly-navigated tab's on-mount code — set it for a leading
   * `goto`; leave it off for an already-live tab whose handlers fire later (on a click).
   */
  async arm(bindBeforeFirstRun: boolean): Promise<void> {
    this.#driver.on(Cdp.Page.loadEventFired, () => { this.#loaded = true; });
    await this.#driver.send(Cdp.Debugger.enable).catch(() => {});
    await this.#driver.send(Cdp.Debugger.setPauseOnExceptions, { state: "none" }).catch(() => {});
    await this.#driver.send(Cdp.Runtime.addBinding, { name: BINDING_NAME }).catch(() => {});
    await this.#driver.send(Cdp.Runtime.evaluate, { expression: HELPER_SOURCE }).catch(() => {});
    // A navigation builds a fresh context where the serializer global is gone — re-install it per document.
    await this.#driver.send(Cdp.Page.addScriptToEvaluateOnNewDocument, { source: HELPER_SOURCE }).catch(() => {});
    this.#driver.on(Cdp.Runtime.bindingCalled, (event: any) => { if (event?.name === BINDING_NAME) this.#onHit(event.payload); });
    if (bindBeforeFirstRun) await this.#armFirstRunBindPause();
    this.#driver.on(Cdp.Debugger.paused, (paused: any) => { void this.#onPause(paused); });
    await this.#binder.tryBind(this.#driver, this.#sourceMaps);
  }

  /**
   * ⏸️ THE ONE PAUSE (see class doc). Arm a `beforeScriptExecution` instrumentation breakpoint so the engine
   * halts just before each new script runs, long enough to bind any breakpoint that script carries before its
   * first-run code executes. This is the only VM halt in the whole tracer; {@link #onPause} drops it once
   * binding settles. Logpoint hits do NOT come through here.
   */
  async #armFirstRunBindPause(): Promise<void> {
    const result = await this.#driver.send(Cdp.Debugger.setInstrumentationBreakpoint, { instrumentation: "beforeScriptExecution" }).catch(() => null);
    this.#firstRunPauseId = result?.breakpointId ?? null;
  }

  /** Re-bind after a navigation — newly-parsed chunks may carry a previously-unbound breakpoint. */
  async reBind(): Promise<void> {
    await this.#binder.tryBind(this.#driver, this.#sourceMaps).catch(() => {});
  }

  /** This tab's breakpoint-binding report (bound/unbound per breakpoint). */
  report(): Breakpoint[] {
    return this.#binder.report();
  }

  /** A logpoint fired. Serialize conversions (the stack resolve is async) so sequence + ordering stay stable. */
  #onHit(payload: string): void {
    if (this.#hits.length >= this.#config.maxHits) return;
    this.#chain = this.#chain.then(async () => {
      if (this.#hits.length >= this.#config.maxHits) return;
      const event = await this.#capturer.toEvent(payload, this.#events.length + 1).catch(() => null);
      if (!event) return;
      this.#events.push(event);
      this.#hits.push({ ev: event, t: Date.now() });
      this.#config.onEvent?.(this.#hits.map((hit) => hit.ev));
    });
  }

  /**
   * The handler for THE ONE PAUSE (see class doc). Only a `reason: "instrumentation"` halt does real work —
   * bind the just-parsed scripts, then drop the pause once everything's bound (or the page finished loading,
   * or we hit the cap). ANY other pause is not ours (e.g. a `debugger;` statement in the traced app); resume
   * immediately so a logpoint trace can never freeze. Breakpoint *hits* never reach here — they don't pause.
   */
  async #onPause(paused: any): Promise<void> {
    try {
      if (paused.reason !== "instrumentation") { await this.#driver.send(Cdp.Debugger.resume).catch(() => {}); return; }
      const underHitCap = this.#hits.length < this.#config.maxHits;
      if (underHitCap && !this.#binder.allSettled()) await this.#binder.tryBind(this.#driver, this.#sourceMaps);
      if ((this.#binder.allSettled() || this.#loaded || !underHitCap) && this.#firstRunPauseId) {
        const firstRunPauseId = this.#firstRunPauseId; this.#firstRunPauseId = null;
        await this.#driver.send(Cdp.Debugger.removeBreakpoint, { breakpointId: firstRunPauseId }).catch(() => {}); // drop THE ONE PAUSE
      }
    } catch { /* keep the journey moving */ }
    await this.#driver.send(Cdp.Debugger.resume).catch(() => {});
  }
}
