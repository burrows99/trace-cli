import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Tracer, type CaptureResult, type TraceOptions } from "../../engine/Tracer.js";
import { Recorder } from "../../engine/Recorder.js";
import { LineageAnalyzer } from "../../analysis/LineageAnalyzer.js";
import { Trace, TraceMeta, TraceData, CurlResponse } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { Recording } from "../../domain/Recording.js";
import { TargetKind } from "../../domain/Target.js";
import type { ArtifactStore } from "../../storage/ArtifactStore.js";
import { VERSION } from "../../shared/version.js";

export type DynamicTargetKind = TargetKind;

export interface DynamicRequest extends TraceOptions {
  target: DynamicTargetKind;
  record?: boolean;            // chrome: render + upload a debug-replay video (on by default)
  recordOut?: string;          // explicit output path (else a temp file)
}

export interface DynamicResult { trace: Trace; capture: CaptureResult; }

/**
 * DynamicCommand — orchestrates a breakpoint trace: pick the tracer by target, run it, normalize the
 * capture into a Trace (lineage + diagnostics), and (for Chrome) record + upload the replay. Collaborators
 * are injected (Tracer, ArtifactStore) — Dependency Inversion; this class owns the use-case, not the IO.
 */
export class DynamicCommand {
  constructor(
    private readonly tracer: Tracer = new Tracer(),
    private readonly artifacts?: ArtifactStore,
  ) {}

  async run(req: DynamicRequest): Promise<DynamicResult> {
    const startedAtMs = performance.now();
    const sessionId = req.sessionId ?? randomUUID();
    const opts: TraceOptions = { ...req, sessionId, record: req.record };

    const capture =
      req.target === TargetKind.Chrome ? await this.tracer.traceChrome(opts)
      : await this.tracer.traceNode(opts);

    const trace = this.#toTrace(capture, { sessionId, args: req.args ?? {}, startedAtMs });

    if (req.target === TargetKind.Chrome && req.record !== false) {
      await this.#record(capture, trace, sessionId, req.recordOut);
    }
    return { trace, capture };
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
    return new Trace({
      version: VERSION,
      command: `dynamic.${c.target}`,
      ok: !c.fatal,
      meta: new TraceMeta({ at: new Date().toISOString(), sessionId: ctx.sessionId, args: ctx.args, durationMs: Math.round(performance.now() - ctx.startedAtMs) }),
      target: { kind: c.target, source, trigger: c.trigger },
      data,
      diagnostics,
    });
  }

  /** Render the Chrome debug-replay video, upload it (if an ArtifactStore is configured), attach the link. */
  async #record(capture: CaptureResult, trace: Trace, sessionId: string, out?: string): Promise<void> {
    try {
      const path = out ?? join(tmpdir(), `trace-${sessionId}.mp4`);
      const mp4 = await Recorder.renderJourney(capture.frames ?? [], capture.traced ?? [], path);
      if (!mp4) { process.stderr.write("[trace] no frames captured — nothing to record\n"); return; }
      const up = this.artifacts && this.artifacts.isConfigured() ? await this.artifacts.upload(mp4, `recordings/${sessionId}.mp4`, "video/mp4") : null;
      trace.data.recording = up ? new Recording({ url: up.url, bytes: up.bytes }) : new Recording({ path: mp4 });
      process.stderr.write(up ? `[trace] recording → ${up.url}\n` : `[trace] recording → ${mp4} (set S3_ENDPOINT to upload + get a link)\n`);
    } catch (e: any) {
      process.stderr.write(`[trace] recording failed: ${e.message}\n`);
    }
  }
}
