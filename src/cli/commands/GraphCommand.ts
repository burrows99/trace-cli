import { isAbsolute, resolve } from "node:path";

import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { logger } from "../../shared/logger.js";
import { Code } from "../../shared/codes.js";
import { findProjectRoot } from "../../shared/projectRoot.js";
import { createCodeGraphProvider } from "../../codegraph/createCodeGraphProvider.js";
import type { CodeGraph, EntryReference } from "../../codegraph/CodeGraphProvider.js";
import { TraceCommand } from "./TraceCommand.js";
import { GraphView } from "./GraphView.js";

const log = logger.child({ component: "graph" });
const MAX_NODES = 2000; // internal safety cap on graph size; --depth is the user-facing size knob

export interface GraphRequest {
  entry: EntryReference;
  provider?: string;
  root?: string;             // optional: auto-detected from the entry file when absent
  maxDepth: number;
  includeExternal?: boolean; // default false — externals (node_modules / outside-root) shown as leaves
  maxNodes?: number;         // default MAX_NODES — internal safety cap, not a user knob
  server?: string;
  args?: Record<string, unknown>;
}

/**
 * GraphCommand — orchestrates a static call-graph build: pick the provider (factory), build the outgoing-call
 * graph rooted at the entry, and normalize it into one Trace envelope (`data.graph`). The provider is the
 * injected collaborator (Dependency Inversion); this class owns the use-case and the envelope, not the analysis.
 * A resolution/analysis failure becomes an error diagnostic on a still-well-formed envelope, matching how the
 * run command surfaces engine failures — an agent always gets back a Trace.
 */
export class GraphCommand extends TraceCommand<GraphRequest> {
  async run(request: GraphRequest): Promise<Trace> {
    const startedAtMs = this.started();
    const provider = createCodeGraphProvider(request.provider);
    const diagnostics: Diagnostic[] = [];
    let data = new TraceData({});

    try {
      // Resolve the entry to an absolute path, then auto-detect the project root from it when --root is absent
      // (nearest tsconfig/package.json/.git ancestor — what an IDE does), so the common case is just --entry.
      const baseDirectory = request.root ? resolve(request.root) : process.cwd();
      const entryFile = isAbsolute(request.entry.file) ? request.entry.file : resolve(baseDirectory, request.entry.file);
      const root = request.root ? resolve(request.root) : findProjectRoot(entryFile);
      const graph = await provider.callGraph({ ...request.entry, file: entryFile }, {
        root,
        maxDepth: request.maxDepth,
        includeExternal: request.includeExternal ?? false,
        maxNodes: request.maxNodes ?? MAX_NODES,
        server: request.server,
      });
      data = new TraceData({ graph });
      if (graph.stats.truncated) {
        diagnostics.push(Diagnostic.warn(Code.GRAPH_TRUNCATED, `graph truncated at depth ${request.maxDepth} — raise --depth for more, or pick a more specific entry`));
      }
    } catch (error: any) {
      diagnostics.push(Diagnostic.error(Code.CODEGRAPH_FAILED, String(error?.message ?? error).split("\n")[0]));
      log.error("call graph failed", { code: Code.CODEGRAPH_FAILED, provider: provider.name, err: error });
    }

    // `ok` derives from the diagnostics: a CODEGRAPH_FAILED error flips it false, GRAPH_TRUNCATED (warn) doesn't.
    return this.envelope({
      command: `graph.${provider.name}`,
      data,
      diagnostics,
      args: request.args ?? {},
      startedAtMs,
    });
  }

  /** Human view: the call graph unrolled into a flow tree, with shared callees, cycles and externals marked. */
  render(trace: Trace): string {
    const graph = trace.data.graph as CodeGraph | undefined;
    const guard = this.emptyRender(trace, !!graph?.nodes?.length, "graph", "no nodes");
    return guard !== undefined ? guard : GraphView.tree(graph!);
  }

  /** HTML view: the same call graph as an interactive node-and-edge diagram (see {@link GraphView.callGraphHtml}). */
  renderHtml(trace: Trace): string {
    return GraphView.callGraphHtml(trace);
  }
}
