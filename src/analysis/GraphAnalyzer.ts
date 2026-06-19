import { createCodeGraphProvider } from "../codegraph/createCodeGraphProvider.js";
import type {
  CallGraphOptions, CodeGraph, CodeGraphProvider, EntryReference, ProviderAvailability,
} from "../codegraph/CodeGraphProvider.js";
import { Analyzer } from "./Analyzer.js";

/** The resolved input one graph build needs: where to start, plus the bounded build knobs. */
export interface GraphAnalysisInput {
  entry: EntryReference;
  options: CallGraphOptions;
}

/**
 * GraphAnalyzer — the graphical analysis. Sibling to {@link LineageAnalyzer}: both are {@link Analyzer}s that
 * normalize raw signal into a domain shape — lineage turns the runtime event timeline into Lineage[], the graph
 * turns a language server's call hierarchy into a CodeGraph (nodes + edges). The actual call-hierarchy walk is
 * delegated to a pluggable {@link CodeGraphProvider} (LSP today); GraphAnalyzer is the analysis-tier seam that
 * lets the `graph` command depend on `Analyzer`, with the provider as the swappable backend behind it.
 */
export class GraphAnalyzer extends Analyzer<GraphAnalysisInput, CodeGraph> {
  /** Stable id mirrors the backing provider — it drives the envelope command `graph.<name>`. */
  readonly name: string;

  constructor(private readonly provider: CodeGraphProvider = createCodeGraphProvider()) {
    super();
    this.name = provider.name;
  }

  /** Can this analysis run against `root`? (the backing provider's CLI/library resolves.) Never throws. */
  isAvailable(root: string): Promise<ProviderAvailability> {
    return this.provider.isAvailable(root);
  }

  /** Build the outgoing-call graph rooted at the entry. Throws with a clear message on unresolvable input. */
  analyze(input: GraphAnalysisInput): Promise<CodeGraph> {
    return this.provider.callGraph(input.entry, input.options);
  }
}
