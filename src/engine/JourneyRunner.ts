import { performance } from "node:perf_hooks";
import { IsBoolean, IsInt, IsOptional, IsString } from "class-validator";

import { CdpDriver, log } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { TargetKind } from "../domain/Target.js";
import { Screencaster } from "./Screencaster.js";
import { SourceMaps } from "./SourceMaps.js";
import { BpBinder } from "./BpBinder.js";
import { EventCapturer, type CdpCtx } from "./EventCapturer.js";
import { type ResolvedBp } from "./BreakpointResolver.js";
import { TraceEvent } from "../domain/TraceEvent.js";
import { Breakpoint } from "../domain/Breakpoint.js";
import { sleep } from "../shared/sleep.js";

export interface Step { action: "goto" | "eval" | "click" | "type" | "wait" | "waitfor" | "newtab"; arg?: string; value?: string; }

/** StepResult — the validated outcome of one journey step (a failure becomes a STEP_FAILED diagnostic on the Trace). */
export class StepResult {
  @IsInt() seq: number;
  @IsString() step: string;
  @IsInt() t: number;
  @IsBoolean() ok: boolean;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() url?: string;

  constructor(init: Partial<StepResult> = {}) {
    this.seq = init.seq ?? 0;
    this.step = init.step ?? "";
    this.t = init.t ?? 0;
    this.ok = init.ok ?? false;
    Object.assign(this, init);
  }
}
export interface TracedHit { ev: TraceEvent; t: number; }
export interface TraceConfig { bps: ResolvedBp[]; root?: string; exprs: string[]; frames: number; maxHits: number; }

const FIND_EL = `(sel)=>{
  const vis = e => e && e.offsetParent !== null && e.getClientRects().length;
  if (sel.startsWith('text=')) {
    const t = sel.slice(5).trim().toLowerCase();
    const els = [...document.querySelectorAll('button,a,[role=button],input[type=submit],[role=link],li,div,span')];
    const hit = els.filter(e => vis(e) && (e.innerText||e.textContent||'').trim().toLowerCase().includes(t))
                   .sort((a,b)=> (a.innerText||'').length - (b.innerText||'').length)[0];
    return hit || null;
  }
  return document.querySelector(sel);
}`;

interface TraceState { binder: BpBinder; sm: SourceMaps; capturer: EventCapturer; ctx: CdpCtx; instrId: string | null; }

/**
 * JourneyRunner — drives a scripted UI journey across one or more page targets and feeds the active target
 * to the Screencaster. It performs real, trusted input (CDP Input.dispatchMouseEvent), so handlers gated on
 * a user gesture — e.g. Pulse's `window.open(deeplink, '_blank')` impersonation — actually fire, and it
 * follows the spawned tab by polling the target list and re-pointing the screencast at it.
 *
 * When given breakpoints, it ALSO arms each newly-opened tab the way the Tracer does (instrumentation pause
 * → bind before first run) and captures every hit with a wall-clock timestamp — so the recorder can lay the
 * trace panel beside the live screencast. Vendor-neutral: URLs, selectors, breakpoints all come from input.
 */
export class JourneyRunner {
  #port: number;
  #cast: Screencaster;
  #trace?: TraceConfig;
  #current!: CdpDriver;
  #drivers: CdpDriver[] = [];
  #known = new Set<string>();
  #traceStates = new Map<CdpDriver, TraceState>();
  #t0 = 0;
  readonly traced: TracedHit[] = [];
  finalUrl?: string;

  constructor(port: number, cast: Screencaster, trace?: TraceConfig) { this.#port = port; this.#cast = cast; this.#trace = trace; }

  /** Parse a `--step` string: `action`, `action:arg`, or `type:<selector>=<text>`. */
  static parseStep(raw: string): Step {
    const colon = raw.indexOf(":");
    const action = (colon === -1 ? raw : raw.slice(0, colon)).trim() as Step["action"];
    const rest = colon === -1 ? "" : raw.slice(colon + 1);
    if (action === "type") {
      const eq = rest.indexOf("=");
      return { action, arg: eq === -1 ? rest : rest.slice(0, eq), value: eq === -1 ? "" : rest.slice(eq + 1) };
    }
    return rest ? { action, arg: rest } : { action };
  }

  /** Breakpoint-binding report merged across tabs — a bp counts as bound if it bound in any tab the journey drove. */
  breakpoints(): Breakpoint[] {
    const byKey = new Map<string, Breakpoint>();
    for (const st of this.#traceStates.values()) {
      for (const b of st.binder.report()) {
        const k = `${b.file}:${b.line}`;
        const prev = byKey.get(k);
        if (!prev || (b.bound && !prev.bound)) byKey.set(k, b);
      }
    }
    return [...byKey.values()];
  }

  async #pages(): Promise<any[]> {
    return (await CdpDriver.listTargets(this.#port, TargetKind.Chrome)).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  }

  /**
   * Arm breakpoint tracing on a target and capture hits live. `instrument` pauses before each script's first
   * run (needed for a freshly-opened tab whose code runs once on load — e.g. the web app's exchange); for an
   * already-live tab (e.g. Pulse, where the handler fires later on click) we skip it and just bind, re-binding
   * after each navigation as new chunks parse.
   */
  async #armTrace(driver: CdpDriver, instrument: boolean): Promise<void> {
    if (!this.#trace) return;
    const sm = new SourceMaps(driver, this.#trace.root);
    const binder = new BpBinder(this.#trace.bps);
    const capturer = new EventCapturer(driver);
    const ctx: CdpCtx = { t0: performance.now(), events: [], frames: this.#trace.frames, exprs: this.#trace.exprs, steps: [], sm, bpById: binder.bpById };
    const state: TraceState = { binder, sm, capturer, ctx, instrId: null };
    this.#traceStates.set(driver, state);
    await driver.send(Cdp.Debugger.enable).catch(() => {});
    await driver.send(Cdp.Debugger.setPauseOnExceptions, { state: "none" }).catch(() => {});
    if (instrument) {
      const r = await driver.send(Cdp.Debugger.setInstrumentationBreakpoint, { instrumentation: "beforeScriptExecution" }).catch(() => null);
      state.instrId = r?.breakpointId ?? null;
    }
    driver.on(Cdp.Debugger.paused, (p: any) => { void this.#onPause(driver, state, p); });
    await binder.tryBind(driver, sm);
  }

  #loaded = new WeakSet<CdpDriver>();

  async #onPause(driver: CdpDriver, st: TraceState, paused: any): Promise<void> {
    try {
      const cap = !this.#trace || this.traced.length < this.#trace.maxHits;
      if (paused.reason === "instrumentation") {
        if (cap && !st.binder.allSettled()) await st.binder.tryBind(driver, st.sm);
        if ((st.binder.allSettled() || this.#loaded.has(driver) || !cap) && st.instrId) {
          const id = st.instrId; st.instrId = null;
          await driver.send(Cdp.Debugger.removeBreakpoint, { breakpointId: id }).catch(() => {});
        }
      } else if (cap) {
        const ev = await st.capturer.capture(paused, "breakpoint", st.ctx);
        st.ctx.events.push(ev);
        this.traced.push({ ev, t: Date.now() });
      }
    } catch { /* keep the journey moving even if a capture fails */ }
    await driver.send(Cdp.Debugger.resume).catch(() => {});
  }

  async #connect(target: any, opts: { trace?: boolean; instrument?: boolean } = {}): Promise<CdpDriver> {
    const d = await CdpDriver.connect(target.webSocketDebuggerUrl);
    await d.send(Cdp.Page.enable).catch(() => {});
    await d.send(Cdp.Runtime.enable).catch(() => {});
    await d.send(Cdp.DOM.enable).catch(() => {});
    d.on(Cdp.Page.loadEventFired, () => this.#loaded.add(d));
    this.#drivers.push(d);
    this.#known.add(target.id);
    if (opts.trace && this.#trace) await this.#armTrace(d, !!opts.instrument);
    return d;
  }

  /** Attach to an existing page (or one matching `urlMatch`) and begin recording it. */
  async start(urlMatch?: string): Promise<void> {
    const pages = await this.#pages();
    if (!pages.length) throw new Error(`no page target on :${this.#port} — is the debug Chrome up?`);
    const target = (urlMatch && pages.find((p) => (p.url || "").includes(urlMatch))) || pages[0];
    for (const p of pages) this.#known.add(p.id); // everything open now is "known"; only future tabs count as new
    // launcher tab (e.g. Pulse): trace it too, but bind-after-load (no instrumentation) — its handlers fire on click, not first run
    this.#current = await this.#connect(target, { trace: true, instrument: false });
    this.#t0 = Date.now();
    await this.#cast.switch(this.#current);
  }

  async #eval(expr: string, awaitPromise = true): Promise<any> {
    const r = await this.#current.send(Cdp.Runtime.evaluate, { expression: expr, awaitPromise, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "evaluate failed");
    return r.result?.value;
  }

  /** A user `eval:` step — wrapped in an async IIFE so `await` is legal; the result is awaited. */
  async #evalUser(js: string): Promise<any> {
    return this.#eval(`(async()=>{ ${js} })()`, true);
  }

  async #centerOf(sel: string): Promise<{ x: number; y: number } | null> {
    const js = `(()=>{const f=${FIND_EL};const el=f(${JSON.stringify(sel)});if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`;
    return this.#eval(js, false);
  }

  async #click(sel: string): Promise<boolean> {
    const c = await this.#centerOf(sel);
    if (!c) return false;
    await sleep(120); // let scrollIntoView settle
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.#current.send(Cdp.Input.dispatchMouseEvent, { type, x: Math.round(c.x), y: Math.round(c.y), button: "left", buttons: 1, clickCount: 1 });
    }
    return true;
  }

  async #waitFor(sel: string, timeoutMs = 12000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const js = `(()=>{const f=${FIND_EL};return !!f(${JSON.stringify(sel)});})()`;
    while (Date.now() < deadline) { if (await this.#eval(js, false).catch(() => false)) return true; await sleep(200); }
    return false;
  }

  async #waitNewTab(timeoutMs = 12000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const fresh = (await this.#pages()).find((p) => !this.#known.has(p.id));
      if (fresh) {
        this.#current = await this.#connect(fresh, { trace: true, instrument: true }); // opened app tab — catch its first-run code
        await sleep(300);
        await this.#cast.switch(this.#current);
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  async #goto(url: string): Promise<void> {
    let loaded = false;
    this.#current.on(Cdp.Page.loadEventFired, () => { loaded = true; });
    await this.#current.send(Cdp.Page.navigate, { url });
    const deadline = Date.now() + 15000;
    while (!loaded && Date.now() < deadline) await sleep(100);
    await sleep(800); // settle render/SPA hydration
    // re-bind: a navigation parses new chunks (e.g. Pulse's member page), so previously-unbound breakpoints may resolve now.
    const st = this.#traceStates.get(this.#current);
    if (st) await st.binder.tryBind(this.#current, st.sm).catch(() => {});
  }

  async run(steps: Step[]): Promise<StepResult[]> {
    const results: StepResult[] = [];
    let seq = 0;
    for (const s of steps) {
      seq++;
      // redact eval bodies / typed values — they can carry credentials we must not echo to logs or output.
      const label = s.action === "eval" ? `eval:${(s.arg || "").replace(/\s+/g, " ").slice(0, 32)}…`
        : s.action === "type" ? `type:${s.arg}=***`
        : `${s.action}${s.arg ? ":" + s.arg : ""}`;
      let ok = true, note: string | undefined;
      try {
        switch (s.action) {
          case "goto": await this.#goto(s.arg!); break;
          case "eval": await this.#evalUser(s.arg!); break;
          case "click": ok = await this.#click(s.arg!); if (!ok) note = "selector not found"; break;
          case "type": {
            const c = await this.#centerOf(s.arg!);
            if (!c) { ok = false; note = "selector not found"; break; }
            for (const type of ["mousePressed", "mouseReleased"] as const) await this.#current.send(Cdp.Input.dispatchMouseEvent, { type, x: Math.round(c.x), y: Math.round(c.y), button: "left", buttons: 1, clickCount: 1 });
            await this.#current.send(Cdp.Input.insertText, { text: s.value ?? "" });
            break;
          }
          case "wait": await sleep(parseInt(s.arg || "1000", 10)); break;
          case "waitfor": ok = await this.#waitFor(s.arg!); if (!ok) note = "timed out waiting"; break;
          case "newtab": ok = await this.#waitNewTab(); if (!ok) note = "no new tab appeared"; break;
        }
      } catch (e: any) { ok = false; note = String(e?.message || e).split("\n")[0]; }
      const url = await this.#eval("location.href", false).catch(() => undefined);
      this.finalUrl = url || this.finalUrl;
      results.push(new StepResult({ seq, step: label, t: Date.now() - this.#t0, ok, ...(note ? { note } : {}), ...(url ? { url } : {}) }));
      log(`step ${seq} ${label} → ${ok ? "ok" : "FAILED" + (note ? " (" + note + ")" : "")}`);
      await sleep(250); // a beat between steps so the video reads
    }
    return results;
  }

  close(): void { for (const d of this.#drivers) d.close(); }
}
