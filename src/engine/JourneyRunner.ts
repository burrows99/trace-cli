import { IsBoolean, IsInt, IsOptional, IsString } from "class-validator";

import { CdpDriver, log } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { TargetKind } from "../domain/Target.js";
import { Screencaster } from "./Screencaster.js";
import { PageActions } from "./PageActions.js";
import { TabTracer } from "./TabTracer.js";
import { type ResolvedBp } from "./BreakpointResolver.js";
import { type Step, parseStep } from "./JourneyStep.js";
import { TraceEvent } from "../domain/TraceEvent.js";
import { Breakpoint } from "../domain/Breakpoint.js";
import { sleep } from "../shared/sleep.js";

export type { Step } from "./JourneyStep.js";

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
export interface TraceConfig { bps: ResolvedBp[]; root?: string; exprs: string[]; frames: number; maxHits: number; onEvent?: (events: TraceEvent[]) => void; }

/**
 * JourneyRunner — orchestrates a scripted UI journey across one or more page targets: discover (or open) a
 * tab, drive each step, follow any spawned tab and re-point the screencast at it, and — when given
 * breakpoints — attach a {@link TabTracer} per tab so the recorder can lay a live trace panel beside the
 * screen. Responsibilities are split: tab plumbing lives here, DOM input in {@link PageActions}, breakpoint
 * capture in {@link TabTracer}. Vendor-neutral: URLs, selectors and breakpoints all come from input.
 */
export class JourneyRunner {
  #port: number;
  #cast: Screencaster;
  #trace?: TraceConfig;
  #current!: CdpDriver;
  #page!: PageActions;
  #drivers: CdpDriver[] = [];
  #known = new Set<string>();
  #tracers = new Map<CdpDriver, TabTracer>();
  #t0 = 0;
  readonly traced: TracedHit[] = [];
  finalUrl?: string;

  constructor(port: number, cast: Screencaster, trace?: TraceConfig) { this.#port = port; this.#cast = cast; this.#trace = trace; }

  /** Parse a `--step` string into a {@link Step}. Vocabulary is validated upstream by `StepInput`, not here. */
  static parseStep(raw: string): Step {
    return parseStep(raw);
  }

  /** Breakpoint-binding report merged across tabs — a bp counts as bound if it bound in any tab the journey drove. */
  breakpoints(): Breakpoint[] {
    const byKey = new Map<string, Breakpoint>();
    for (const tracer of this.#tracers.values()) {
      for (const b of tracer.report()) {
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

  /** Connect to a target, enable its domains, and (when tracing) attach a TabTracer. */
  async #connect(target: any, opts: { trace?: boolean; bindBeforeFirstRun?: boolean } = {}): Promise<CdpDriver> {
    const d = await CdpDriver.connect(target.webSocketDebuggerUrl);
    await d.send(Cdp.Page.enable).catch(() => {});
    await d.send(Cdp.Runtime.enable).catch(() => {});
    await d.send(Cdp.DOM.enable).catch(() => {});
    // Focus the tab we drive. A backgrounded tab can't open a popup, so a handler that calls
    // `window.open(deeplink, '_blank')` AFTER an `await` (e.g. Pulse's impersonation, where the open lands
    // past the click's user-gesture) is silently swallowed unless its tab is foreground. That's why the flow
    // worked only when a human/devtools happened to have the tab focused — not when driven unattended.
    // No-op-safe on headless targets, so it's unconditional.
    await d.send(Cdp.Page.bringToFront).catch(() => {});
    this.#drivers.push(d);
    this.#known.add(target.id);
    if (opts.trace && this.#trace) {
      const tracer = new TabTracer(d, this.#trace, this.traced);
      this.#tracers.set(d, tracer);
      await tracer.arm(!!opts.bindBeforeFirstRun);
    }
    return d;
  }

  /** Make `d` the active tab: drive it via a fresh PageActions and point the screencast at it. */
  async #switchTo(d: CdpDriver): Promise<void> {
    this.#current = d;
    this.#page = new PageActions(d);
    await this.#cast.switch(d);
  }

  /**
   * Attach to an existing page (or one matching `urlMatch`) and begin recording it. `bindBeforeFirstRun` arms
   * THE ONE PAUSE (see {@link TabTracer}) so breakpoints bind *before* the upcoming navigation's scripts run —
   * set it when the journey opens with a `goto`, so first-run / on-mount code (e.g. a SPA computing a value
   * during initial render) is caught instead of missed. Left false for an attach-then-click flow, where the
   * tab is already live and its handlers fire later on a click.
   */
  async start(urlMatch?: string, bindBeforeFirstRun = false): Promise<void> {
    let pages = await this.#pages();
    if (!pages.length) {
      // The debug Chrome is up but tabless (a prior run / the impersonation popup closed its tabs). Open a
      // blank tab so attach is robust to tab state — the first `goto:` step navigates it. This removes the
      // most common "no page target on :PORT" failure, which forced a manual re-seed of a tab before each run.
      log(`no page target on :${this.#port} — opening a blank tab to attach`);
      await CdpDriver.createPageTarget(this.#port).catch((e) => log(`could not open a tab on :${this.#port}: ${e?.message || e}`));
      await sleep(300);
      pages = await this.#pages();
      if (!pages.length) throw new Error(`no page target on :${this.#port} and could not open one — is the debug Chrome up?`);
    }
    const target = (urlMatch && pages.find((p) => (p.url || "").includes(urlMatch))) || pages[0];
    for (const p of pages) this.#known.add(p.id); // everything open now is "known"; only future tabs count as new
    const d = await this.#connect(target, { trace: true, bindBeforeFirstRun });
    this.#t0 = Date.now();
    await this.#switchTo(d);
  }

  /** Poll for a freshly-opened tab (e.g. the impersonation popup), attach (binding before its first run), and follow it. */
  async #waitNewTab(timeoutMs = 12000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const fresh = (await this.#pages()).find((p) => !this.#known.has(p.id));
      if (fresh) {
        const d = await this.#connect(fresh, { trace: true, bindBeforeFirstRun: true }); // opened app tab — bind before its first-run code
        await sleep(300);
        await this.#switchTo(d);
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  /** Navigate the active tab, then re-bind its breakpoints (a navigation parses new chunks). */
  async #goto(url: string): Promise<void> {
    await this.#page.navigate(url);
    await this.#tracers.get(this.#current)?.reBind();
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
          case "eval": await this.#page.evalUser(s.arg!); break;
          case "click": ok = await this.#page.click(s.arg!); if (!ok) note = "selector not found"; break;
          case "type": ok = await this.#page.type(s.arg!, s.value ?? ""); if (!ok) note = "selector not found"; break;
          case "wait": await sleep(parseInt(s.arg || "1000", 10)); break;
          case "waitfor": ok = await this.#page.waitFor(s.arg!); if (!ok) note = "timed out waiting"; break;
          case "newtab": ok = await this.#waitNewTab(); if (!ok) note = "no new tab appeared"; break;
        }
      } catch (e: any) { ok = false; note = String(e?.message || e).split("\n")[0]; }
      const url = await this.#page.currentUrl();
      this.finalUrl = url || this.finalUrl;
      results.push(new StepResult({ seq, step: label, t: Date.now() - this.#t0, ok, ...(note ? { note } : {}), ...(url ? { url } : {}) }));
      log(`step ${seq} ${label} → ${ok ? "ok" : "FAILED" + (note ? " (" + note + ")" : "")}`);
      await sleep(250); // a beat between steps so the video reads
    }
    return results;
  }

  close(): void { for (const d of this.#drivers) d.close(); }
}
