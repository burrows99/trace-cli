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
  record?: boolean;            // chrome: render + upload a debug-replay video (on by default)
  recordOut?: string;          // explicit output path (else a temp file)
}

export interface DynamicResult { trace: Trace; capture: CaptureResult; }

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

    // Chrome launch mode (`--chrome` with no port): spawn a throwaway headless Chrome to BE the trace target,
    // then tear it down. Attach mode (`--chrome <port>`) skips this and uses the running browser as-is.
    let launched: LaunchedChrome | undefined;
    try {
      let opts: TraceOptions = { ...req, sessionId, record: req.record };
      if (req.target === TargetKind.Chrome && req.launch) {
        launched = await ChromeLauncher.launch();
        opts = { ...opts, port: launched.port };
      }

      const capture =
        req.target === TargetKind.Chrome ? await this.tracer.traceChrome(opts)
        : await this.tracer.traceNode(opts);

      const trace = this.#toTrace(capture, { sessionId, args: req.args ?? {}, startedAtMs });

      if (req.target === TargetKind.Chrome && req.record !== false) {
        await this.#record(capture, trace, sessionId, req.recordOut);
      }
      return { trace, capture };
    } finally {
      launched?.kill();
    }
  }

  #toTrace(c: CaptureResult, ctx: { sessionId: string; args: Record<string, unknown>; startedAtMs: number }): Trace {
    const source = "cdp";
    const diagnostics: Diagnostic[] = [];
    if (c.fatal) diagnostics.push(Diagnostic.error("ENGINE_FATAL", String(c.fatal).split("\n")[0]));
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
    return this.envelope({
      command: `dynamic.${c.target}`,
      ok: !c.fatal,
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
