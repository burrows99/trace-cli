import { Tracer } from "../engine/Tracer.js";
import { S3ArtifactStore } from "../storage/S3ArtifactStore.js";
import { Collector, type EmitResult } from "../collector/Collector.js";
import { RunCommand } from "../cli/commands/RunCommand.js";
import { GraphCommand } from "../cli/commands/GraphCommand.js";
import { DepsCommand } from "../cli/commands/DepsCommand.js";
import { ComplexityCommand } from "../cli/commands/ComplexityCommand.js";
import { SymbolsCommand } from "../cli/commands/SymbolsCommand.js";
import { DoctorCommand } from "../cli/commands/DoctorCommand.js";
import { Diagnostic } from "../domain/Diagnostic.js";
import type { Trace } from "../domain/Trace.js";
import { logger } from "../shared/logger.js";
import { Code } from "../shared/codes.js";
import type {
  NormalizedRun, ProcessingResult, GraphRequest, DepsRequest, ComplexityRequest, SymbolsRequest,
} from "./descriptors.js";

const log = logger.child({ component: "processing" });

/**
 * EngineAbortError — thrown by ProcessingManager.runTrace when the run threw (attach failed,
 * engine crashed, recording threw). By this point the terminal envelope has already been streamed to the
 * collector and the emit chain flushed, so each frontend just decides the response: the CLI exits 1, HTTP
 * answers 500, MCP returns an error tool result. Carries the original cause for logging.
 */
export class EngineAbortError extends Error {
  readonly code = Code.ENGINE_FATAL;
  constructor(override readonly cause: unknown) {
    super(String((cause as Error)?.message ?? cause).split("\n")[0]);
    this.name = "EngineAbortError";
  }
}

/**
 * emitFailureMessage — the end-of-run diagnostic for collector emit failures. An HTTP status means the collector
 * received the request and rejected it; no status means the POST never landed (connection refused/timeout/DNS),
 * so word each distinctly rather than calling both "rejected". `count` is the total failed emits this run; `last`
 * is the most recent failure (whose reason is shown). Extracted so the wording/count stay unit-testable.
 */
export function emitFailureMessage(collector: string, count: number, last: EmitResult): string {
  return last.status
    ? `collector ${collector} rejected ${count} emit(s): HTTP ${last.status}${last.body ? ` — ${last.body.slice(0, 200)}` : ""}`
    : `${count} emit(s) to collector ${collector} failed: ${last.error ?? "unknown error"}`;
}

/**
 * ProcessingManager — the orchestration tier. Owns everything that turns a validated request into a finished
 * {@link Trace}: resolving the collector, serializing the streaming emit chain, wiring `onProgress`, the abort
 * flush, and folding a collector failure into a diagnostic — then running the command. It performs no stdout /
 * `process.exit`; it returns a {@link ProcessingResult} the OutputManager + adapter consume. The run command
 * is injected (so tests can drive it with a fake tracer); the static commands are cheap to construct per call.
 */
export class ProcessingManager {
  constructor(
    private readonly runCommand: RunCommand = new RunCommand(new Tracer(), new S3ArtifactStore()),
  ) {}

  /**
   * Run a breakpoint trace. Streams to the collector (an explicit --emit / TRACE_COLLECTOR_URL wins,
   * else a locally-running dashboard is auto-discovered). Emits are serialized through one promise chain so a
   * slow POST can't land a stale envelope after a newer one. On a run that throws, the terminal envelope was
   * already emitted via onProgress — flush the chain so that POST lands, then throw {@link EngineAbortError}.
   */
  async runTrace(normalized: NormalizedRun): Promise<ProcessingResult> {
    const collector = await Collector.resolve(normalized.emit);
    let emitChain: Promise<unknown> = Promise.resolve();
    // Only the count and the most recent failure are surfaced, so keep just those — not every failed result.
    // onProgress can emit on a hot path, and retaining each failure would grow memory without bound.
    let emitFailureCount = 0;
    let lastEmitFailure: EmitResult | undefined;
    const emitToCollector = collector
      ? (envelope: unknown) => { emitChain = emitChain.then(async () => { const result = await Collector.emit(collector, envelope); if (!result.ok) { emitFailureCount++; lastEmitFailure = result; } }); }
      : undefined;

    let trace: Trace;
    try {
      ({ trace } = await this.runCommand.run({
        ...normalized.request,
        ...(emitToCollector ? { onProgress: (intermediateTrace: Trace) => emitToCollector(intermediateTrace.toJSON()) } : {}),
      }));
    } catch (error) {
      // The run threw. It already emitted a TERMINAL envelope via onProgress that clears the dashboard's
      // "running" session — flush the chain so that POST actually lands, then surface the failure to the caller.
      if (emitToCollector) await emitChain;
      log.error("run aborted before completion", { code: Code.ENGINE_FATAL, err: error });
      throw new EngineAbortError(error);
    }

    // Flush the final (complete) envelope and all pending emits BEFORE returning, so a rejected emit (a 400
    // schema error, a 503 dead store) becomes a visible diagnostic in the printed/--json envelope instead of
    // vanishing into an info log. The snapshot emitted here is pre-schema-gate (the gate runs later, in the
    // OutputManager) and pre-EMIT-diagnostic — matching the long-standing behavior the dashboard relies on.
    if (emitToCollector) {
      emitToCollector(trace.toJSON());
      await emitChain;
      if (lastEmitFailure && collector) {
        trace.diagnostics.push(Diagnostic.warn(Code.EMIT, emitFailureMessage(collector, emitFailureCount, lastEmitFailure)));
      }
    }
    return { trace, render: () => this.runCommand.render(trace) };
  }

  async runGraph(request: GraphRequest): Promise<ProcessingResult> {
    const command = new GraphCommand();
    const trace = await command.run(request);
    return { trace, render: () => command.render(trace), renderHtml: () => command.renderHtml(trace) };
  }

  async runDeps(request: DepsRequest): Promise<ProcessingResult> {
    const command = new DepsCommand();
    const trace = await command.run(request);
    return { trace, render: () => command.render(trace), renderHtml: () => command.renderHtml(trace) };
  }

  async runComplexity(request: ComplexityRequest): Promise<ProcessingResult> {
    const command = new ComplexityCommand();
    const trace = await command.run(request);
    return { trace, render: () => command.render(trace) };
  }

  async runSymbols(request: SymbolsRequest): Promise<ProcessingResult> {
    const command = new SymbolsCommand();
    const trace = await command.run(request);
    return { trace, render: () => command.render(trace) };
  }

  async runDoctor(): Promise<ProcessingResult> {
    const command = new DoctorCommand();
    const trace = await command.run();
    return { trace, render: () => command.render(trace) };
  }

  /**
   * Forward a finished STATIC envelope to a collector — explicit-only (`TRACE_COLLECTOR_URL`), never the
   * run command's auto-discovery: a static analysis carries no sessionId, so the session dashboard can't ingest it.
   * Called by the adapter AFTER the output gate so the collector sees the same gated envelope the CLI printed.
   */
  async forwardStatic(trace: Trace): Promise<void> {
    const collector = process.env.TRACE_COLLECTOR_URL;
    if (collector) await Collector.emit(collector, trace.toJSON());
  }
}
