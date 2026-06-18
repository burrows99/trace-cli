import { performance } from "node:perf_hooks";

import { CdpDriver, log } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { SourceMaps } from "./SourceMaps.js";
import { BreakpointResolver } from "./BreakpointResolver.js";
import { BpBinder } from "./BpBinder.js";
import { EventCapturer, type CdpCtx } from "./EventCapturer.js";
import { CurlTrigger, type CurlResult } from "./CurlTrigger.js";
import { Screencaster } from "./Screencaster.js";
import { JourneyRunner, type StepResult, type TraceConfig } from "./JourneyRunner.js";
import { TraceEvent } from "../domain/TraceEvent.js";
import { Breakpoint } from "../domain/Breakpoint.js";
import { TargetKind } from "../domain/Target.js";
import type { ConsoleLine, NetworkLine } from "../domain/Trace.js";
import { sleep } from "../shared/sleep.js";
import { DEFAULT_NODE_PORT, DEFAULT_CHROME_PORT, DEFAULT_ATTACH_TIMEOUT_MS } from "../shared/defaults.js";

export interface CaptureResult {
  target: TargetKind;
  trigger: string | null;
  breakpoints: Breakpoint[];
  events: TraceEvent[];
  response?: CurlResult;
  console?: ConsoleLine[];
  network?: NetworkLine[];
  finalUrl?: string;
  screenshot?: string;
  /** motion screencast frames captured during a Chrome `--record` run (left side of the replay video). */
  frames?: { data: Buffer; t: number }[];
  /** breakpoint hits stamped with wall-clock time, so the replay can lay the trace panel beside each frame. */
  traced?: { ev: TraceEvent; t: number }[];
  /** Chrome: the per-step outcome of the scripted journey (a failed step → a STEP_FAILED diagnostic). */
  steps?: StepResult[];
  fatal?: string;
}

export interface TraceOptions {
  port: number;
  wsUrl?: string;
  breakpoints?: string[];
  root?: string;
  exprs?: string[];
  steps?: string[];
  frames?: number;
  maxHits?: number;
  timeoutMs?: number;
  attachTimeoutMs?: number;
  reqTimeoutMs?: number;
  curl?: string;
  url?: string;
  shot?: string;
  record?: boolean;
  urlMatch?: string;
  titleMatch?: string;
  sessionId?: string;
  args?: Record<string, unknown>;
  /**
   * Progress hook, fired once per captured event with the full set of events captured *so far* (the same
   * growing array, shared across tabs for Chrome). Lets the command layer stream partial traces to a
   * collector while the run is still in flight, instead of only emitting the finished envelope.
   */
  onEvent?: (events: TraceEvent[]) => void;
}

/**
 * A CapturePlan is the *only* thing that differs between the Node and Chrome targets. Everything
 * structural — connect, enable, bind-before-trigger, the pause/capture loop, cleanup — lives in
 * Tracer.#capture and is shared. So a change to capture/binding/teardown affects both targets at once;
 * a change to arming or triggering touches just the one target that needs it.
 */
interface CapturePlan {
  result: CaptureResult;
  /** discover the CDP websocket for this target. */
  resolveWs(): Promise<string>;
  /** target-specific protocol domains beyond Runtime+Debugger (Chrome: Page+Network). */
  enableExtra(driver: CdpDriver): Promise<void>;
  /** wire event listeners (Chrome: console/network/load). */
  attach(driver: CdpDriver): void;
  /**
   * Make breakpoints bindable *before* the traced code runs. Node: the process is already up with its
   * scripts parsed, so we just let them settle. Chrome: a fresh page hasn't parsed anything yet, so we
   * arm a `beforeScriptExecution` instrumentation pause — the engine then binds as each script appears
   * during the trigger navigation, before that script executes.
   */
  arm(driver: CdpDriver): Promise<void>;
  /** true for targets whose binding is interleaved with the trigger via instrumentation pauses. */
  instrumentation: boolean;
  /** the page finished loading (Chrome) — used to stop instrumentation pumping and to shorten waits. */
  loaded(): boolean;
  /** fire the trigger that exercises the code (Node: curl; Chrome: navigate). Non-blocking. */
  fire(driver: CdpDriver, ctx: CdpCtx): void;
  /** per-pause wait budget. */
  timeout(): number;
  /** wait budget for step plans at the first hit. */
  stepTimeoutMs: number;
  /** a `null` pause means the wait was interrupted; Node breaks (curl is done), Chrome keeps going. */
  stopOnInterrupt: boolean;
  /** stop after capturing a hit (Node: once the trigger settled and nothing is queued). */
  shouldStop(driver: CdpDriver): boolean;
  /** drop the instrumentation pause once binding is settled (Chrome). */
  removeInstr(driver: CdpDriver): Promise<void>;
  /** await any outstanding trigger work (Node: the curl promise). */
  drain(): Promise<void>;
  /** post-capture work (Chrome: final url + screenshot, stop screencast). */
  finish(driver: CdpDriver): Promise<void>;
  /** notified of each captured breakpoint event (Chrome --record: stamps it with wall-clock time). */
  onCapture?(ev: TraceEvent): void;
}

/**
 * Tracer — the trigger+capture engine, one method per target, each returning a CaptureResult so the command
 * layer treats targets symmetrically. Depends on the CdpDriver (ProtocolDriver) via DIP. `traceNode` binds
 * into an already-running `--inspect` process and fires one curl through the shared `#capture` pump loop.
 * `traceChrome` drives a scripted UI journey across tabs and records it — a fundamentally different control
 * flow (multi-step, async, tab-following), so it delegates to JourneyRunner rather than the one-shot pump;
 * the breakpoint primitives (BpBinder, EventCapturer, SourceMaps) are shared across both. Produces domain
 * entities (TraceEvent, Breakpoint) — the command layer assembles them into a Trace.
 */
export class Tracer {
  // ---- shared CDP helpers ----------------------------------------------------------------------

  async #settleScripts(driver: CdpDriver, ms = 1500): Promise<void> {
    let prev = -1, stable = 0;
    for (let i = 0; i < ms / 100; i++) {
      const n = driver.scripts().size;
      if (n === prev) { if (++stable >= 3) break; } else stable = 0;
      prev = n;
      await sleep(100);
    }
  }

  // ---- the one capture loop, shared by every target -------------------------------------------

  async #capture(opts: TraceOptions, plan: CapturePlan): Promise<CaptureResult> {
    const { breakpoints = [], root, exprs = [], steps = [], frames = 6, maxHits = 25, attachTimeoutMs = DEFAULT_ATTACH_TIMEOUT_MS, sessionId } = opts;
    const bps = BreakpointResolver.resolveAll(breakpoints, root);
    const result = plan.result;
    const driver = await CdpDriver.connect(opts.wsUrl || (await plan.resolveWs()), attachTimeoutMs);
    const sm = new SourceMaps(driver, root);
    const ctx: CdpCtx = { t0: performance.now(), events: result.events, frames, exprs, steps, sm, bpById: new Map(), sessionId };
    const binder = new BpBinder(bps);
    const capturer = new EventCapturer(driver);
    plan.attach(driver);
    try {
      await driver.send(Cdp.Runtime.enable);
      await driver.send(Cdp.Debugger.enable);
      await driver.send(Cdp.Debugger.setPauseOnExceptions, { state: "none" });
      await plan.enableExtra(driver);
      await plan.arm(driver);
      await binder.tryBind(driver, sm);          // Node binds here; Chrome binds during instrumentation pumping
      ctx.bpById = binder.bpById;

      ctx.t0 = performance.now();
      plan.fire(driver, ctx);

      while (result.events.length < maxHits) {
        let paused: any;
        try { paused = await driver.waitForStop(plan.timeout()); } catch { break; }
        if (paused === null) { if (plan.stopOnInterrupt) break; else continue; }
        // Chrome: a script is about to run for the first time — bind any breakpoints it carries, then resume.
        if (plan.instrumentation && paused.reason === "instrumentation") {
          if (!binder.allSettled()) { await binder.tryBind(driver, sm); ctx.bpById = binder.bpById; }
          if (binder.allSettled() || plan.loaded()) await plan.removeInstr(driver);
          await driver.send(Cdp.Debugger.resume).catch(() => {});
          continue;
        }
        const ev = await capturer.capture(paused, "breakpoint", ctx);
        result.events.push(ev);
        plan.onCapture?.(ev);
        opts.onEvent?.(result.events);
        await capturer.runSteps(ctx, plan.stepTimeoutMs);
        await driver.send(Cdp.Debugger.resume).catch(() => {});
        if (plan.shouldStop(driver)) break;
      }
      await plan.drain();
      await plan.finish(driver);
    } catch (e: any) {
      result.fatal = String(e?.stack || e?.message || e); log("FATAL", result.fatal.split("\n")[0]);
    } finally {
      result.breakpoints = binder.report();
      for (const miss of binder.unbound()) log(`bp ${miss} → not bound (line not on this path / wrong route?)`);
      await plan.removeInstr(driver).catch(() => {});
      for (const id of ctx.bpById.keys()) await driver.send(Cdp.Debugger.removeBreakpoint, { breakpointId: id }).catch(() => {});
      await driver.send(Cdp.Debugger.resume).catch(() => {});
      driver.close(); sm.dispose();
    }
    return result;
  }

  // ---- targets: each builds a CapturePlan, then hands off to the shared loop --------------------

  async traceNode(opts: TraceOptions): Promise<CaptureResult> {
    const { port = DEFAULT_NODE_PORT, curl, urlMatch, titleMatch, timeoutMs = 30000, reqTimeoutMs = 60000 } = opts;
    const result: CaptureResult = { target: TargetKind.Node, trigger: curl ?? null, breakpoints: [], events: [] };
    let triggerDone = !curl;
    let triggerPromise: Promise<void> = Promise.resolve();
    const plan: CapturePlan = {
      result,
      resolveWs: () => CdpDriver.resolveWsUrl(port, { kind: TargetKind.Node, urlMatch, titleMatch }),
      enableExtra: async () => {},
      attach: () => {},
      arm: async (driver) => { await this.#settleScripts(driver); },
      instrumentation: false,
      loaded: () => false,
      fire: (driver, ctx) => {
        if (!curl) return;
        ctx.t0 = performance.now();
        log(`fired: ${curl.length > 90 ? curl.slice(0, 90) + "…" : curl}`);
        triggerPromise = CurlTrigger.run(curl, reqTimeoutMs).then((r) => { result.response = r; }).finally(() => { triggerDone = true; driver.interrupt(); });
      },
      timeout: () => timeoutMs,
      stepTimeoutMs: timeoutMs,
      stopOnInterrupt: true,
      shouldStop: (driver) => triggerDone && !driver.hasQueued(),
      removeInstr: async () => {},
      drain: async () => { await triggerPromise.catch(() => {}); },
      finish: async () => {},
    };
    return this.#capture(opts, plan);
  }

  /**
   * Chrome target: drive the scripted UI journey (`opts.steps`) with breakpoints armed on every tab and the
   * screencast running throughout, so one run yields the trace events AND the frames/hits the recorder lays
   * into a screen + trace-panel replay. Multi-step + tab-following needs JourneyRunner's async, sequential
   * driver — not the single-trigger `#capture` pump — but the binding/capture primitives are the same.
   */
  async traceChrome(opts: TraceOptions): Promise<CaptureResult> {
    const { port = DEFAULT_CHROME_PORT, steps = [], breakpoints = [], root, exprs = [], frames = 6, maxHits = 30, urlMatch } = opts;
    const parsed = steps.map((s) => JourneyRunner.parseStep(s));
    const cast = new Screencaster();
    const config: TraceConfig = { bps: BreakpointResolver.resolveAll(breakpoints, root), root, exprs, frames, maxHits, onEvent: opts.onEvent };
    const runner = new JourneyRunner(port, cast, config);
    let stepResults: StepResult[] = [];
    let fatal: string | undefined;
    try {
      // A journey that opens with a navigation needs the first tab instrumented, so breakpoints bind before
      // that page's scripts run (on-mount code executes once and is otherwise missed). parseStep guarantees order.
      await runner.start(urlMatch, parsed[0]?.action === "goto");
      stepResults = await runner.run(parsed);
    } catch (e: any) {
      fatal = String(e?.message ?? e);
    } finally {
      await cast.stop().catch(() => {});
      runner.close();
    }
    return {
      target: TargetKind.Chrome,
      trigger: parsed.find((s) => s.action === "goto")?.arg ?? `${parsed.length} steps`,
      breakpoints: runner.breakpoints(),
      events: runner.traced.map((h) => h.ev),
      steps: stepResults,
      frames: cast.frames(),
      traced: runner.traced,
      ...(runner.finalUrl ? { finalUrl: runner.finalUrl } : {}),
      ...(fatal ? { fatal } : {}),
    };
  }
}
