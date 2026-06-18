import { performance } from "node:perf_hooks";

import { Trace, TraceMeta, TraceData } from "../../domain/Trace.js";
import type { Diagnostic } from "../../domain/Diagnostic.js";
import type { TargetRef } from "../../domain/Target.js";
import { VERSION } from "../../shared/version.js";
import { CliCommand } from "./CliCommand.js";

/** The command-specific pieces of a Trace; {@link TraceCommand.envelope} stamps everything common around them. */
export interface Envelope {
  command: string;                          // e.g. "dynamic.node", "graph.lsp", "doctor"
  data: TraceData;
  diagnostics?: Diagnostic[];
  ok?: boolean;                             // default: true unless a diagnostic is an error
  startedAtMs?: number;                     // when given → meta.durationMs (from performance.now())
  sessionId?: string;
  args?: Record<string, unknown>;
  toolVersions?: Record<string, string>;
  target?: TargetRef | null;
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
  protected envelope(e: Envelope): Trace {
    const diagnostics = e.diagnostics ?? [];
    return new Trace({
      version: VERSION,
      command: e.command,
      ok: e.ok ?? !diagnostics.some((d) => d.level === "error"),
      meta: new TraceMeta({
        at: new Date().toISOString(),
        ...(e.sessionId ? { sessionId: e.sessionId } : {}),
        ...(e.args ? { args: e.args } : {}),
        ...(e.toolVersions ? { toolVersions: e.toolVersions } : {}),
        ...(e.startedAtMs !== undefined ? { durationMs: Math.round(performance.now() - e.startedAtMs) } : {}),
      }),
      target: e.target ?? null,
      data: e.data,
      diagnostics,
    });
  }

  /** The human-readable view of a finished Trace (what prints when `--json` is off). */
  abstract render(trace: Trace): string;
}
