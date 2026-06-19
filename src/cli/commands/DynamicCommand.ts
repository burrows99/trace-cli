import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Tracer, type CaptureResult, type TraceOptions } from "../../engine/Tracer.js";
import { Recorder } from "../../engine/Recorder.js";
import { ChromeLauncher } from "../../engine/ChromeLauncher.js";
import { ChromeSession } from "../../engine/ChromeSession.js";
import { Renderer } from "../../engine/Renderer.js";
import { LineageAnalyzer } from "../../analysis/LineageAnalyzer.js";
import { Trace, TraceData, CurlResponse } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { Recording } from "../../domain/Recording.js";
import { TargetKind, TargetReference } from "../../domain/Target.js";
import type { ArtifactStore } from "../../storage/ArtifactStore.js";
import { logger } from "../../shared/logger.js";
import { Code } from "../../shared/codes.js";
import { TraceCommand } from "./TraceCommand.js";

const log = logger.child({ component: "dynamic" });

export type DynamicTargetKind = TargetKind;

export interface DynamicRequest extends TraceOptions {
  target: DynamicTargetKind;
  launch?: boolean;            // chrome: spawn a throwaway headless Chrome instead of attaching to `port`
  profileDir?: string;         // chrome: launch on a persistent --user-data-dir (a real, logged-in profile)
  headed?: boolean;            // chrome: launch the browser visibly instead of headless
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

  async run(request: DynamicRequest): Promise<DynamicResult> {
    const startedAtMs = this.started();
    const sessionId = request.sessionId ?? randomUUID();
    const isChrome = request.target === TargetKind.Chrome;
    // Provisional trigger for the running envelopes (the final one carries the exact value from the capture):
    // node → the curl; chrome → the first goto: URL, else a step count.
    const gotoStep = request.steps?.find((step) => step.startsWith("goto:"))?.slice("goto:".length);
    const trigger = isChrome ? (gotoStep ?? (request.steps?.length ? `${request.steps.length} steps` : null)) : (request.curl ?? null);
    const context: RunCtx = { sessionId, target: request.target, trigger, args: request.args ?? {}, startedAtMs };

    // The session exists in the collector the instant the run begins (0 events), then updates on every hit.
    request.onProgress?.(this.#runningTrace([], context));

    // Chrome: acquire the browser through the launcher — it decides attach (`--chrome <port>`, used as-is),
    // throwaway headless (`--chrome` no port), or a persistent logged-in profile (`--chrome-profile`), and hands
    // back a session whose kill() tears down only what WE launched. Node needs none of this.
    let session: ChromeSession | undefined;
    try {
      let options: TraceOptions = {
        ...request, sessionId,
        ...(request.onProgress ? { onEvent: (events) => request.onProgress!(this.#runningTrace(events, context)) } : {}),
      };
      if (isChrome) {
        session = await ChromeLauncher.acquire({ port: request.port, launch: request.launch, profileDir: request.profileDir, headed: request.headed });
        options = { ...options, port: session.port };
      }

      // Both targets go through the engine the same way: one method, one CaptureResult. Chrome layers on the
      // extra it alone supports — the screen + trace-panel recording.
      const capture = isChrome ? await this.tracer.traceChrome(options) : await this.tracer.traceNode(options);
      const trace = this.#toTrace(capture, { sessionId, args: request.args ?? {}, startedAtMs });
      if (isChrome) await this.#record(capture, trace, sessionId, request.recordOut);
      return { trace, capture };
    } catch (error) {
      // A throw here (attach failed, engine crashed, recording threw) would otherwise leave the initial
      // `running` partial (emitted above) orphaned in the dashboard forever — the session never resolves.
      // Emit a TERMINAL envelope (no `running` flag → meta.running absent; ok:false via the error diagnostic)
      // so the dashboard flips it to failed, and surface the cause in the stderr trail with the same code.
      log.error("trace run aborted before completion", { code: Code.ENGINE_FATAL, sessionId, err: error });
      request.onProgress?.(this.#abortedTrace(error, context));
      throw error;
    } finally {
      session?.kill();
    }
  }

  /** A terminal envelope for a run that threw: empty data, an ENGINE_FATAL error, and crucially NO `running`
   *  flag, so the collector resolves the session instead of leaving its initial running partial hanging. */
  #abortedTrace(error: unknown, context: RunCtx): Trace {
    return this.envelope({
      command: `run.${context.target}`,
      data: new TraceData({ events: [] }),
      diagnostics: [Diagnostic.error(Code.ENGINE_FATAL, String((error as Error)?.message ?? error).split("\n")[0])],
      sessionId: context.sessionId,
      args: context.args,
      startedAtMs: context.startedAtMs,
      target: new TargetReference({ kind: context.target, source: "cdp", trigger: context.trigger }),
    });
  }

  /**
   * A partial, mid-run envelope: the same shape as the finished trace but flagged `running` and carrying only
   * the events captured so far (lineage/recording/diagnostics are computed once at the end in {@link #toTrace}).
   */
  #runningTrace(events: CaptureResult["events"], context: RunCtx): Trace {
    return this.envelope({
      command: `run.${context.target}`,
      data: new TraceData({ events }),
      running: true,
      sessionId: context.sessionId,
      args: context.args,
      startedAtMs: context.startedAtMs,
      target: new TargetReference({ kind: context.target, source: "cdp", trigger: context.trigger }),
    });
  }

  #toTrace(capture: CaptureResult, context: { sessionId: string; args: Record<string, unknown>; startedAtMs: number }): Trace {
    const source = "cdp";
    const diagnostics: Diagnostic[] = [];
    if (capture.fatal) {
      log.error("engine reported a fatal error", { code: Code.ENGINE_FATAL, sessionId: context.sessionId, fatal: String(capture.fatal).split("\n")[0] });
      diagnostics.push(Diagnostic.error(Code.ENGINE_FATAL, String(capture.fatal).split("\n")[0]));
    }
    // A failed journey step (selector not found / timed out) flips the envelope's `ok` — same gate the old
    // `journey` command applied to its exit code, now expressed as an error diagnostic.
    for (const step of capture.steps ?? []) if (!step.ok) diagnostics.push(Diagnostic.error(Code.STEP_FAILED, `#${step.sequence} ${step.step}${step.note ? " — " + step.note : ""}`));
    for (const breakpoint of capture.breakpoints.filter((breakpoint) => !breakpoint.bound)) {
      diagnostics.push(Diagnostic.warn(Code.BP_UNBOUND, `${breakpoint.file}:${breakpoint.line} did not bind${breakpoint.note ? " — " + breakpoint.note : ""}`));
    }
    // Bound-but-unhit: the breakpoint attached but no event fired. Without this an agent reading `--json`
    // sees only `bound:true, events:[]` with no diagnostic and has to guess "no trigger" vs "wrong line" —
    // exactly the fork that stalls a debugging loop. Mirror the human renderer's "no breakpoints hit" line.
    const boundCount = capture.breakpoints.filter((breakpoint) => breakpoint.bound).length;
    if (boundCount > 0 && capture.events.length === 0) {
      diagnostics.push(Diagnostic.warn(Code.BP_BOUND_UNHIT, `${boundCount} breakpoint(s) bound but never hit — the trigger may not have exercised this path (wrong route/branch, or the trigger didn't run).`));
    }
    const lineage = LineageAnalyzer.compute(capture.events);
    const data = new TraceData({
      breakpoints: capture.breakpoints,
      events: capture.events,
      ...(lineage.length ? { lineage } : {}),
      ...(capture.response ? { response: new CurlResponse(capture.response) } : {}),
      ...(capture.console?.length ? { console: capture.console } : {}),
      ...(capture.network?.length ? { network: capture.network } : {}),
      ...(capture.finalUrl ? { finalUrl: capture.finalUrl } : {}),
      ...(capture.screenshot ? { screenshot: capture.screenshot } : {}),
    });
    // `ok` derives from the diagnostics: ENGINE_FATAL or STEP_FAILED (errors) flip it false; BP_UNBOUND (warn) doesn't.
    return this.envelope({
      command: `run.${capture.target}`,
      data,
      diagnostics,
      sessionId: context.sessionId,
      args: context.args,
      startedAtMs: context.startedAtMs,
      target: new TargetReference({ kind: capture.target, source, trigger: capture.trigger }),
    });
  }

  /** Human view of a dynamic trace: the breakpoint/timeline render plus the lineage panel. */
  render(trace: Trace): string {
    return Renderer.render(trace) + Renderer.renderLineage(trace.data.lineage);
  }

  /** Render the Chrome debug-replay video, upload it (if an ArtifactStore is configured), attach the link. */
  async #record(capture: CaptureResult, trace: Trace, sessionId: string, outputPath?: string): Promise<void> {
    try {
      const videoOutputPath = outputPath ?? join(tmpdir(), `trace-${sessionId}.mp4`);
      const videoPath = await Recorder.renderJourney(capture.frames ?? [], capture.traced ?? [], videoOutputPath);
      if (!videoPath) {
        // Both channels carry the same code: the stderr trail AND an envelope diagnostic, so an agent reading
        // --json learns the chrome run produced no video (instead of inferring it from a missing `recording`).
        log.warn("no frames captured — nothing to record", { code: Code.RECORD_EMPTY, sessionId });
        trace.diagnostics.push(Diagnostic.warn(Code.RECORD_EMPTY, "no frames captured — the debug-replay video is empty (no breakpoint hits, or the journey produced no frames)."));
        return;
      }
      const uploadConfigured = this.artifacts?.isConfigured() ?? false;
      const upload = uploadConfigured ? await this.artifacts!.upload(videoPath, `recordings/${sessionId}.mp4`, "video/mp4") : null;
      trace.data.recording = upload ? new Recording({ url: upload.url, bytes: upload.bytes }) : new Recording({ path: videoPath });
      if (upload) {
        log.info("recording uploaded", { sessionId, url: upload.url, bytes: upload.bytes });
      } else if (uploadConfigured) {
        // S3 WAS configured but upload() returned null → it failed (the error was logged inside the store).
        // The video is still saved locally, but the dashboard gets no link — surface that instead of
        // reporting a clean local save, so "no video link" isn't silently indistinguishable from success.
        log.warn("recording upload failed — keeping local copy", { code: Code.UPLOAD, sessionId, path: videoPath });
        trace.diagnostics.push(Diagnostic.warn(Code.UPLOAD, `recording upload failed — video saved locally at ${videoPath}, no dashboard link (check S3_ENDPOINT / credentials).`));
      } else {
        log.info("recording saved locally — set S3_ENDPOINT to upload + get a link", { sessionId, path: videoPath });
      }
    } catch (error: any) {
      // Render or upload threw. Surface it in the envelope too (a warn — the trace data is still valid, only
      // the replay is missing) so "no video" is never silent. Previously this was a stderr log the agent never saw.
      log.error("recording failed", { code: Code.RECORD, sessionId, err: error });
      trace.diagnostics.push(Diagnostic.warn(Code.RECORD, `debug-replay recording failed — ${String(error?.message ?? error).split("\n")[0]}`));
    }
  }
}
