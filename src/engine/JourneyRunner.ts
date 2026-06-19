import { IsBoolean, IsInt, IsOptional, IsString } from "class-validator";

import { CdpDriver, log } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { ChromeSession } from "./ChromeSession.js";
import { Screencaster } from "./Screencaster.js";
import { PageActions } from "./PageActions.js";
import { TabTracer } from "./TabTracer.js";
import { type ResolvedBreakpoint } from "./BreakpointResolver.js";
import { type Step, parseStep } from "./JourneyStep.js";
import { TraceEvent } from "../domain/TraceEvent.js";
import { Breakpoint } from "../domain/Breakpoint.js";
import { sleep } from "../shared/sleep.js";

export type { Step } from "./JourneyStep.js";

/** StepResult — the validated outcome of one journey step (a failure becomes a STEP_FAILED diagnostic on the Trace). */
export class StepResult {
  @IsInt() sequence: number;
  @IsString() step: string;
  @IsInt() t: number;
  @IsBoolean() ok: boolean;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() url?: string;

  constructor(init: Partial<StepResult> = {}) {
    this.sequence = init.sequence ?? 0;
    this.step = init.step ?? "";
    this.t = init.t ?? 0;
    this.ok = init.ok ?? false;
    Object.assign(this, init);
  }
}

export interface TracedHit { ev: TraceEvent; t: number; }
export interface TraceConfig { bps: ResolvedBreakpoint[]; root?: string; exprs: string[]; frames: number; maxHits: number; onEvent?: (events: TraceEvent[]) => void; }

/**
 * JourneyRunner — orchestrates a scripted UI journey across one or more page targets: open a fresh tab in the
 * target window, drive each step, follow any spawned tab and re-point the screencast at it, and — when given
 * breakpoints — attach a {@link TabTracer} per tab so the recorder can lay a live trace panel beside the
 * screen. Responsibilities are split: tab plumbing lives here, DOM input in {@link PageActions}, breakpoint
 * capture in {@link TabTracer}. Vendor-neutral: URLs, selectors and breakpoints all come from input.
 */
export class JourneyRunner {
  #chrome: ChromeSession;
  #screencaster: Screencaster;
  #trace?: TraceConfig;
  #current!: CdpDriver;
  #page!: PageActions;
  #drivers: CdpDriver[] = [];
  #known = new Set<string>();
  #tracers = new Map<CdpDriver, TabTracer>();
  #startTime = 0;
  readonly traced: TracedHit[] = [];
  finalUrl?: string;

  constructor(chrome: ChromeSession, screencaster: Screencaster, trace?: TraceConfig) { this.#chrome = chrome; this.#screencaster = screencaster; this.#trace = trace; }

  /** Parse a `--step` string into a {@link Step}. Vocabulary is validated upstream by `StepInput`, not here. */
  static parseStep(rawStep: string): Step {
    return parseStep(rawStep);
  }

  /** Breakpoint-binding report merged across tabs — a bp counts as bound if it bound in any tab the journey drove. */
  breakpoints(): Breakpoint[] {
    const byKey = new Map<string, Breakpoint>();
    for (const tracer of this.#tracers.values()) {
      for (const breakpoint of tracer.report()) {
        const key = `${breakpoint.file}:${breakpoint.line}`;
        const existing = byKey.get(key);
        if (!existing || (breakpoint.bound && !existing.bound)) byKey.set(key, breakpoint);
      }
    }
    return [...byKey.values()];
  }

  async #pages(): Promise<any[]> {
    return this.#chrome.pageTargets();
  }

  /** Connect to a target, enable its domains, and (when tracing) attach a TabTracer. */
  async #connect(target: any, options: { trace?: boolean; bindBeforeFirstRun?: boolean } = {}): Promise<CdpDriver> {
    const driver = await CdpDriver.connect(target.webSocketDebuggerUrl);
    await driver.send(Cdp.Page.enable).catch(() => {});
    await driver.send(Cdp.Runtime.enable).catch(() => {});
    await driver.send(Cdp.DOM.enable).catch(() => {});
    // Focus the tab we drive. A backgrounded tab can't open a popup, so a handler that calls
    // `window.open(deeplink, '_blank')` AFTER an `await` (e.g. Pulse's impersonation, where the open lands
    // past the click's user-gesture) is silently swallowed unless its tab is foreground. That's why the flow
    // worked only when a human/devtools happened to have the tab focused — not when driven unattended.
    // No-op-safe on headless targets, so it's unconditional.
    await driver.send(Cdp.Page.bringToFront).catch(() => {});
    this.#drivers.push(driver);
    this.#known.add(target.id);
    if (options.trace && this.#trace) {
      const tracer = new TabTracer(driver, this.#trace, this.traced);
      this.#tracers.set(driver, tracer);
      await tracer.arm(!!options.bindBeforeFirstRun);
    }
    return driver;
  }

  /** Make `driver` the active tab: drive it via a fresh PageActions and point the screencast at it. */
  async #switchTo(driver: CdpDriver): Promise<void> {
    this.#current = driver;
    this.#page = new PageActions(driver);
    await this.#screencaster.switch(driver);
  }

  /**
   * Open a FRESH tab in the target window and begin recording it. We never reuse or hijack an existing tab —
   * tab targeting is deliberately gone — so an attached, real session keeps its own tabs untouched while our
   * tab rides the same profile (hence the same logins). The journey's first `goto:` step navigates this blank
   * tab. `bindBeforeFirstRun` arms THE ONE PAUSE (see {@link TabTracer}) so breakpoints bind *before* that
   * navigation's scripts run — set it when the journey opens with a `goto`, so first-run / on-mount code (e.g.
   * a SPA computing a value during initial render) is caught instead of missed.
   */
  async start(bindBeforeFirstRun = false): Promise<void> {
    // Everything already open is "known"; only the tab WE open (and any future popup) should count as new.
    for (const page of await this.#pages()) this.#known.add(page.id);
    // Open our own tab and attach to it. /json/new returns the tab descriptor (incl. its websocket), so the
    // common case needs no re-list; some Chrome builds return a thin body, so fall back to spotting our new tab.
    const opened = await this.#chrome.openBlankTab().catch((error) => { log(`could not open a tab on :${this.#chrome.port}: ${error?.message || error}`); return null; });
    let target = opened?.webSocketDebuggerUrl ? opened : null;
    if (!target) {
      await sleep(300);
      target = (await this.#pages()).find((page) => !this.#known.has(page.id)) ?? null;
    }
    if (!target?.webSocketDebuggerUrl) throw new Error(`could not open a tab on :${this.#chrome.port} — is the debug Chrome up?`);
    this.#known.add(target.id);
    const driver = await this.#connect(target, { trace: true, bindBeforeFirstRun });
    this.#startTime = Date.now();
    await this.#switchTo(driver);
  }

  /** Poll for a freshly-opened tab (e.g. the impersonation popup), attach (binding before its first run), and follow it. */
  async #waitNewTab(timeoutMs = 12000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const freshPage = (await this.#pages()).find((page) => !this.#known.has(page.id));
      if (freshPage) {
        const driver = await this.#connect(freshPage, { trace: true, bindBeforeFirstRun: true }); // opened app tab — bind before its first-run code
        await sleep(300);
        await this.#switchTo(driver);
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
    let sequence = 0;
    for (const step of steps) {
      sequence++;
      // redact eval bodies / typed values — they can carry credentials we must not echo to logs or output.
      const label = step.action === "eval" ? `eval:${(step.arg || "").replace(/\s+/g, " ").slice(0, 32)}…`
        : step.action === "type" ? `type:${step.arg}=***`
        : `${step.action}${step.arg ? ":" + step.arg : ""}`;
      let ok = true, note: string | undefined;
      try {
        switch (step.action) {
          case "goto": await this.#goto(step.arg!); break;
          case "eval": await this.#page.evalUser(step.arg!); break;
          case "click": ok = await this.#page.click(step.arg!); if (!ok) note = "selector not found"; break;
          case "type": ok = await this.#page.type(step.arg!, step.value ?? ""); if (!ok) note = "selector not found"; break;
          case "wait": await sleep(parseInt(step.arg || "1000", 10)); break;
          case "waitfor": ok = await this.#page.waitFor(step.arg!); if (!ok) note = "timed out waiting"; break;
          case "newtab": ok = await this.#waitNewTab(); if (!ok) note = "no new tab appeared"; break;
        }
      } catch (error: any) { ok = false; note = String(error?.message || error).split("\n")[0]; }
      const url = await this.#page.currentUrl();
      this.finalUrl = url || this.finalUrl;
      results.push(new StepResult({ sequence, step: label, t: Date.now() - this.#startTime, ok, ...(note ? { note } : {}), ...(url ? { url } : {}) }));
      log(`step ${sequence} ${label} → ${ok ? "ok" : "FAILED" + (note ? " (" + note + ")" : "")}`);
      await sleep(250); // a beat between steps so the video reads
    }
    return results;
  }

  close(): void { for (const driver of this.#drivers) driver.close(); }
}
