import { performance } from "node:perf_hooks";

import { Trace, TraceMeta, TraceData } from "../../domain/Trace.js";
import type { Diagnostic } from "../../domain/Diagnostic.js";
import type { TargetReference } from "../../domain/Target.js";
import { VERSION } from "../../shared/version.js";
import { CliCommand } from "./CliCommand.js";

/** The command-specific pieces of a Trace; {@link TraceCommand.envelope} stamps everything common around them. */
export interface Envelope {
  command: string;                          // e.g. "run.node", "graph.lsp", "doctor"
  data: TraceData;
  diagnostics?: Diagnostic[];
  ok?: boolean;                             // default: true unless a diagnostic is an error
  running?: boolean;                        // true → a partial, mid-run envelope (sets meta.running)
  startedAtMs?: number;                     // when given → meta.durationMs (from performance.now())
  sessionId?: string;
  args?: Record<string, unknown>;
  toolVersions?: Record<string, string>;
  target?: TargetReference | null;
}

/**
 * TraceCommand — the {@link CliCommand} specialization for every command that produces a Trace envelope
 * (dynamic, graph, doctor). Each subclass assembles only its own `data` payload + diagnostics; the base owns
 * the part they all repeated verbatim — stamping version, timestamp and duration, and deriving `ok` from the
 * diagnostics — so the envelope shape stays identical across commands and lives in exactly one place.
 * `render` is the human view each trace-producing command must supply (what prints when `--json` is off).
 */
export abstract class TraceCommand<Req = void, Res = Trace> extends CliCommand<Req, Res> {
  /** Monotonic start stamp for `meta.durationMs`; call at the top of `run()` and hand back via `envelope`. */
  protected started(): number {
    return performance.now();
  }

  /** Wrap a command's payload + diagnostics in the common Trace envelope. */
  protected envelope(envelopeSpec: Envelope): Trace {
    const diagnostics = envelopeSpec.diagnostics ?? [];
    return new Trace({
      version: VERSION,
      command: envelopeSpec.command,
      ok: envelopeSpec.ok ?? !diagnostics.some((diagnostic) => diagnostic.level === "error"),
      meta: new TraceMeta({
        at: new Date().toISOString(),
        ...(envelopeSpec.sessionId ? { sessionId: envelopeSpec.sessionId } : {}),
        ...(envelopeSpec.args ? { args: envelopeSpec.args } : {}),
        ...(envelopeSpec.toolVersions ? { toolVersions: envelopeSpec.toolVersions } : {}),
        ...(envelopeSpec.running ? { running: true } : {}),
        ...(envelopeSpec.startedAtMs !== undefined ? { durationMs: Math.round(performance.now() - envelopeSpec.startedAtMs) } : {}),
      }),
      target: envelopeSpec.target ?? null,
      data: envelopeSpec.data,
      diagnostics,
    });
  }

  /**
   * Shared empty/error guard for `render()`. When the trace has no usable payload, returns the one-line human
   * string every command rendered the same way — `"<label> — failed: <msg>"` if a diagnostic is an error,
   * else `"<label> — <emptyNote>"`. Returns `undefined` when a payload IS present, so the caller renders it.
   * Collapses the copy that lived in graph/deps/complexity/symbols into one place.
   */
  protected emptyRender(trace: Trace, hasPayload: boolean, label: string, emptyNote: string): string | undefined {
    if (hasPayload) return undefined;
    const errorDiagnostic = trace.diagnostics.find((diagnostic) => diagnostic.level === "error");
    return errorDiagnostic ? `${label} — failed: ${errorDiagnostic.message}` : `${label} — ${emptyNote}`;
  }

  /** The human-readable view of a finished Trace (what prints when `--json` is off). */
  abstract render(trace: Trace): string;
}
