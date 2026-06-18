import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Tracer, type CaptureResult, type TraceOptions } from "../../engine/Tracer.js";
import { Recorder } from "../../engine/Recorder.js";
import { ChromeLauncher, type LaunchedChrome } from "../../engine/ChromeLauncher.js";
import { Renderer } from "../../engine/Renderer.js";
import { LineageAnalyzer } from "../../analysis/LineageAnalyzer.js";
import { Trace, TraceData, CurlResponse } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { Recording } from "../../domain/Recording.js";
import { TargetKind, TargetRef } from "../../domain/Target.js";
import type { ArtifactStore } from "../../storage/ArtifactStore.js";
import { logger } from "../../shared/logger.js";
import { TraceCommand } from "./TraceCommand.js";

const log = logger.child({ component: "dynamic" });

export type DynamicTargetKind = TargetKind;

export interface DynamicRequest extends TraceOptions {
  target: DynamicTargetKind;
  launch?: boolean;            // chrome: spawn a throwaway headless Chrome instead of attaching to `port`
  recordOut?: string;          // explicit output path (else a temp file)
  /**
   * Live progress sink: called with a partial Trace as soon as the run starts (0 events) and again on every
   * captured hit, so a collector can show the session the instant it begins and update it in real time —
   * instead of only seeing the finished envelope. The final, complete Trace is the return value, not a callback.
   */
  onProgress?: (trace: Trace) => void;
}

export interface DynamicResult { trace: Trace; capture: CaptureResult; }

/** Context shared by the running (partial) and final envelopes of one trace run. */
interface RunCtx { sessionId: string; target: TargetKind; trigger: string | null; args: Record<string, unknown>; startedAtMs: number; }

/**
 * DynamicCommand — orchestrates a breakpoint trace: pick the tracer by target, run it, normalize the
 * capture into a Trace (lineage + diagnostics), and (for Chrome) record + upload the replay. Collaborators
 * are injected (Tracer, ArtifactStore) — Dependency Inversion; this class owns the use-case, not the IO.
 */
export class DynamicCommand extends TraceCommand<DynamicRequest, DynamicResult> {
  constructor(
    private readonly tracer: Tracer = new Tracer(),
    private readonly artifacts?: ArtifactStore,
  ) {
    super();
  }

  async run(req: DynamicRequest): Promise<DynamicResult> {
    const startedAtMs = this.started();
    const sessionId = req.sessionId ?? randomUUID();
    const isChrome = req.target === TargetKind.Chrome;
    // Provisional trigger for the running envelopes (the final one carries the exact value from the capture):
    // node → the curl; chrome → the first goto: URL, else a step count.
    const gotoStep = req.steps?.find((s) => s.startsWith("goto:"))?.slice("goto:".length);
    const trigger = isChrome ? (gotoStep ?? (req.steps?.length ? `${req.steps.length} steps` : null)) : (req.curl ?? null);
    const ctx: RunCtx = { sessionId, target: req.target, trigger, args: req.args ?? {}, startedAtMs };

    // The session exists in the collector the instant the run begins (0 events), then updates on every hit.
    req.onProgress?.(this.#runningTrace([], ctx));

    // Chrome launch mode (`--chrome` with no port): spawn a throwaway headless Chrome to BE the trace target,
    // then tear it down. Attach mode (`--chrome <port>`) uses the running browser as-is.
    let launched: LaunchedChrome | undefined;
    try {
      let opts: TraceOptions = {
        ...req, sessionId,
        ...(req.onProgress ? { onEvent: (events) => req.onProgress!(this.#runningTrace(events, ctx)) } : {}),
      };
      if (isChrome && req.launch) { launched = await ChromeLauncher.launch(); opts = { ...opts, port: launched.port }; }

      // Both targets go through the engine the same way: one method, one CaptureResult. Chrome layers on the
      // extra it alone supports — the screen + trace-panel recording.
      const capture = isChrome ? await this.tracer.traceChrome(opts) : await this.tracer.traceNode(opts);
      const trace = this.#toTrace(capture, { sessionId, args: req.args ?? {}, startedAtMs });
      if (isChrome) await this.#record(capture, trace, sessionId, req.recordOut);
      return { trace, capture };
    } finally {
      launched?.kill();
    }
  }

  /**
   * A partial, mid-run envelope: the same shape as the finished trace but flagged `running` and carrying only
   * the events captured so far (lineage/recording/diagnostics are computed once at the end in {@link #toTrace}).
   */
  #runningTrace(events: CaptureResult["events"], ctx: RunCtx): Trace {
    return this.envelope({
      command: `dynamic.${ctx.target}`,
      data: new TraceData({ events }),
      running: true,
      sessionId: ctx.sessionId,
      args: ctx.args,
      startedAtMs: ctx.startedAtMs,
      target: new TargetRef({ kind: ctx.target, source: "cdp", trigger: ctx.trigger }),
    });
  }

  #toTrace(c: CaptureResult, ctx: { sessionId: string; args: Record<string, unknown>; startedAtMs: number }): Trace {
    const source = "cdp";
    const diagnostics: Diagnostic[] = [];
    if (c.fatal) diagnostics.push(Diagnostic.error("ENGINE_FATAL", String(c.fatal).split("\n")[0]));
    // A failed journey step (selector not found / timed out) flips the envelope's `ok` — same gate the old
    // `journey` command applied to its exit code, now expressed as an error diagnostic.
    for (const s of c.steps ?? []) if (!s.ok) diagnostics.push(Diagnostic.error("STEP_FAILED", `#${s.seq} ${s.step}${s.note ? " — " + s.note : ""}`));
    for (const b of c.breakpoints.filter((b) => !b.bound)) {
      diagnostics.push(Diagnostic.warn("BP_UNBOUND", `${b.file}:${b.line} did not bind${b.note ? " — " + b.note : ""}`));
    }
    const lineage = LineageAnalyzer.compute(c.events);
    const data = new TraceData({
      breakpoints: c.breakpoints,
      events: c.events,
      ...(lineage.length ? { lineage } : {}),
      ...(c.response ? { response: new CurlResponse(c.response) } : {}),
      ...(c.console?.length ? { console: c.console } : {}),
      ...(c.network?.length ? { network: c.network } : {}),
      ...(c.finalUrl ? { finalUrl: c.finalUrl } : {}),
      ...(c.screenshot ? { screenshot: c.screenshot } : {}),
    });
    // `ok` derives from the diagnostics: ENGINE_FATAL or STEP_FAILED (errors) flip it false; BP_UNBOUND (warn) doesn't.
    return this.envelope({
      command: `dynamic.${c.target}`,
      data,
      diagnostics,
      sessionId: ctx.sessionId,
      args: ctx.args,
      startedAtMs: ctx.startedAtMs,
      target: new TargetRef({ kind: c.target, source, trigger: c.trigger }),
    });
  }

  /** Human view of a dynamic trace: the breakpoint/timeline render plus the lineage panel. */
  render(trace: Trace): string {
    return Renderer.render(trace) + Renderer.renderLineage(trace.data.lineage);
  }

  /** Render the Chrome debug-replay video, upload it (if an ArtifactStore is configured), attach the link. */
  async #record(capture: CaptureResult, trace: Trace, sessionId: string, out?: string): Promise<void> {
    try {
      const path = out ?? join(tmpdir(), `trace-${sessionId}.mp4`);
      const mp4 = await Recorder.renderJourney(capture.frames ?? [], capture.traced ?? [], path);
      if (!mp4) { log.warn("no frames captured — nothing to record", { sessionId }); return; }
      const up = this.artifacts && this.artifacts.isConfigured() ? await this.artifacts.upload(mp4, `recordings/${sessionId}.mp4`, "video/mp4") : null;
      trace.data.recording = up ? new Recording({ url: up.url, bytes: up.bytes }) : new Recording({ path: mp4 });
      if (up) log.info("recording uploaded", { sessionId, url: up.url, bytes: up.bytes });
      else log.info("recording saved locally — set S3_ENDPOINT to upload + get a link", { sessionId, path: mp4 });
    } catch (e: any) {
      log.error("recording failed", { sessionId, err: e });
    }
  }
}
