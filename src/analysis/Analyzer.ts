/**
 * Analyzer — the parent of every analysis in trace-cli. An analysis takes one kind of raw signal (a runtime
 * event timeline, a language server's call hierarchy, …) and normalizes it into a domain shape that consumers
 * render and ship inside the Trace envelope. Subclasses declare a stable `name` and implement `analyze`; the
 * base fixes the contract so the analyses stay interchangeable — a command can depend on `Analyzer<In, Out>`
 * rather than a concrete one, the same Dependency-Inversion seam used by SessionStore / ArtifactStore / the
 * code-graph provider.
 *
 * `analyze` may be sync or async: the lineage analysis is a pure in-process transform (sync); the graph
 * analysis drives an out-of-process language server (async). Each subclass narrows `In`/`Out` and the return to
 * exactly one of the two, so call sites get a precise type while the family shares one shape.
 */
export abstract class Analyzer<In, Out> {
  /** Stable analyzer id — used in logs and the envelope command provenance (e.g. "lineage", "lsp"). */
  abstract readonly name: string;

  /** Normalize the raw input signal into its domain output. */
  abstract analyze(input: In): Out | Promise<Out>;
}
