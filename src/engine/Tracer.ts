import { performance } from "node:perf_hooks";

import { CdpDriver, log } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { SourceMaps } from "./SourceMaps.js";
import { BreakpointBinder } from "./BreakpointBinder.js";
import { BreakpointResolver } from "./BreakpointResolver.js";
import { BINDING_NAME, HELPER_SOURCE, LogpointCapturer } from "./Logpoint.js";
import { CurlTrigger, type CurlResult } from "./CurlTrigger.js";
import { Screencaster } from "./Screencaster.js";
import { CAPTURE_VIEWPORT } from "./Recorder.js";
import { ChromeLauncher } from "./ChromeLauncher.js";
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
  urlMatch?: string;
  titleMatch?: string;
  sessionId?: string;
  args?: Record<string, unknown>;
  /**
   * Progress hook, fired once per captured event with the full set of events captured *so far*. Lets the
   * command layer stream partial traces to a collector while the run is still in flight.
   */
  onEvent?: (events: TraceEvent[]) => void;
}

/**
 * Tracer — the trigger+capture engine, one method per target, each returning a CaptureResult so the command
 * layer treats targets symmetrically. Breakpoints are armed as **non-pausing logpoints** (see {@link BreakpointBinder}):
 * a hit ships its captured stack/locals/exprs out through a CDP binding without ever halting the VM, so the
 * traced app runs at full speed and a hot path is no longer capped by per-hit pause cost. `traceNode` binds
 * into a running `--inspect` process and fires one curl; `traceChrome` drives a scripted UI journey across tabs
 * and records it (delegating to JourneyRunner). The binding/binding-capture primitives are shared across both.
 */
export class Tracer {
  async #settleScripts(driver: CdpDriver, settleMs = 1500): Promise<void> {
    let previousCount = -1, stablePolls = 0;
    for (let poll = 0; poll < settleMs / 100; poll++) {
      const scriptCount = driver.scripts().size;
      if (scriptCount === previousCount) { if (++stablePolls >= 3) break; } else stablePolls = 0;
      previousCount = scriptCount;
      await sleep(100);
    }
  }

  /** Install the logpoint transport on a freshly-enabled context: the emit binding + the in-page serializer. */
  static async installLogpointHelper(driver: CdpDriver): Promise<void> {
    await driver.send(Cdp.Runtime.addBinding, { name: BINDING_NAME }).catch(() => {});
    await driver.send(Cdp.Runtime.evaluate, { expression: HELPER_SOURCE }).catch(() => {});
  }

  // ---- Node target -----------------------------------------------------------------------------

  async traceNode(options: TraceOptions): Promise<CaptureResult> {
    const {
      port = DEFAULT_NODE_PORT, curl, urlMatch, titleMatch, breakpoints = [], root, exprs = [],
      frames = 6, maxHits = 100, attachTimeoutMs = DEFAULT_ATTACH_TIMEOUT_MS, reqTimeoutMs = 60000,
    } = options;
    const result: CaptureResult = { target: TargetKind.Node, trigger: curl ?? null, breakpoints: [], events: [] };
    const driver = await CdpDriver.connect(options.wsUrl || (await CdpDriver.resolveWsUrl(port, { kind: TargetKind.Node, urlMatch, titleMatch })), attachTimeoutMs);
    const sourceMaps = new SourceMaps(driver, root);
    const binder = new BreakpointBinder(BreakpointResolver.resolveAll(breakpoints, root), exprs);

    const startTime = performance.now();
    const capturer = new LogpointCapturer(driver, sourceMaps, startTime, frames);
    const pendingPayloads: string[] = [];
    driver.on(Cdp.Runtime.bindingCalled, (event: any) => { if (event?.name === BINDING_NAME) pendingPayloads.push(event.payload); });
    // Logpoints never pause; this safety resume keeps a stray `debugger;` in the traced app from hanging the run.
    driver.on(Cdp.Debugger.paused, () => { void driver.send(Cdp.Debugger.resume).catch(() => {}); });

    try {
      await driver.send(Cdp.Runtime.enable);
      await driver.send(Cdp.Debugger.enable);
      await driver.send(Cdp.Debugger.setPauseOnExceptions, { state: "none" });
      await Tracer.installLogpointHelper(driver);
      await this.#settleScripts(driver);
      await binder.tryBind(driver, sourceMaps);

      let triggerDone = !curl;
      let response: CurlResult | undefined;
      if (curl) {
        log(`fired: ${curl.length > 90 ? curl.slice(0, 90) + "…" : curl}`);
        void CurlTrigger.run(curl, reqTimeoutMs).then((curlResult) => { response = curlResult; }).finally(() => { triggerDone = true; });
      }
      // Drain: hits are emitted synchronously during request handling, but bindingCalled arrives async — wait
      // for the trigger to settle, then until the payload count goes quiet (or a hard ceiling).
      const deadline = performance.now() + reqTimeoutMs;
      let quietPolls = 0, previousPendingCount = -1;
      while (performance.now() < deadline) {
        await sleep(50);
        const drained = triggerDone && pendingPayloads.length === previousPendingCount;
        if (drained) { if (++quietPolls >= 3) break; } else quietPolls = 0;
        previousPendingCount = pendingPayloads.length;
      }
      result.response = response;
      // Convert the gathered payloads into events (source-map the stacks), respecting maxHits.
      for (const payload of pendingPayloads.slice(0, maxHits)) {
        const event = await capturer.toEvent(payload, result.events.length + 1);
        if (!event) continue;
        result.events.push(event);
        options.onEvent?.(result.events);
      }
    } catch (error: any) {
      result.fatal = String(error?.stack || error?.message || error); log("FATAL", result.fatal.split("\n")[0]);
    } finally {
      result.breakpoints = binder.report();
      for (const unboundBreakpoint of binder.unbound()) log(`bp ${unboundBreakpoint} → not bound (line not on this path / wrong route?)`);
      driver.close(); sourceMaps.dispose();
    }
    return result;
  }

  // ---- Chrome target ---------------------------------------------------------------------------

  /**
   * Chrome target: drive the scripted UI journey (`opts.steps`) with logpoints armed on every tab and the
   * screencast running throughout, so one run yields the trace events AND the frames/hits the recorder lays
   * into a screen + trace-panel replay. Multi-step + tab-following needs JourneyRunner's async, sequential
   * driver; the binding/capture primitives are the same as Node.
   */
  async traceChrome(options: TraceOptions): Promise<CaptureResult> {
    const { port = DEFAULT_CHROME_PORT, steps = [], breakpoints = [], root, exprs = [], frames = 6, maxHits = 100 } = options;
    const parsedSteps = steps.map((step) => JourneyRunner.parseStep(step));
    const screencaster = new Screencaster(CAPTURE_VIEWPORT);   // portrait-ish: fills the replay's left pane, no letterbox
    const config: TraceConfig = { bps: BreakpointResolver.resolveAll(breakpoints, root), root, exprs, frames, maxHits, onEvent: options.onEvent };
    // Wrap the running browser (RunCommand already launched/attached it) as a session so target discovery
    // goes through the bridge, not raw CdpDriver calls.
    const runner = new JourneyRunner(ChromeLauncher.attach(port), screencaster, config);
    let stepResults: StepResult[] = [];
    let fatal: string | undefined;
    try {
      // Arm THE ONE PAUSE (bind-before-first-run, see TabTracer) only when the journey opens by navigating a
      // fresh tab — a leading `goto` — so on-mount code is caught. Attach-then-click flows don't need it.
      const bindBeforeFirstRun = parsedSteps[0]?.action === "goto";
      await runner.start(bindBeforeFirstRun);
      stepResults = await runner.run(parsedSteps);
    } catch (error: any) {
      fatal = String(error?.message ?? error);
    } finally {
      await screencaster.stop().catch(() => {});
      runner.close();
    }
    return {
      target: TargetKind.Chrome,
      trigger: parsedSteps.find((step) => step.action === "goto")?.arg ?? `${parsedSteps.length} steps`,
      breakpoints: runner.breakpoints(),
      events: runner.traced.map((hit) => hit.ev),
      steps: stepResults,
      frames: screencaster.frames(),
      traced: runner.traced,
      ...(runner.finalUrl ? { finalUrl: runner.finalUrl } : {}),
      ...(fatal ? { fatal } : {}),
    };
  }
}
