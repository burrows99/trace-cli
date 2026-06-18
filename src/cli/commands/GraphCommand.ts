import { isAbsolute, resolve } from "node:path";

import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { logger } from "../../shared/logger.js";
import { findProjectRoot } from "../../shared/projectRoot.js";
import { createCodeGraphProvider } from "../../codegraph/createCodeGraphProvider.js";
import type { CodeGraph, EntryRef } from "../../codegraph/CodeGraphProvider.js";
import { TraceCommand } from "./TraceCommand.js";
import { renderGraphHtml, renderGraphTree } from "./graphView.js";

const log = logger.child({ component: "graph" });
const MAX_NODES = 2000; // internal safety cap on graph size; --depth is the user-facing size knob

export interface GraphRequest {
  entry: EntryRef;
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
 * dynamic command surfaces engine failures — an agent always gets back a Trace.
 */
export class GraphCommand extends TraceCommand<GraphRequest> {
  async run(req: GraphRequest): Promise<Trace> {
    const startedAtMs = this.started();
    const provider = createCodeGraphProvider(req.provider);
    const diagnostics: Diagnostic[] = [];
    let data = new TraceData({});

    try {
      // Resolve the entry to an absolute path, then auto-detect the project root from it when --root is absent
      // (nearest tsconfig/package.json/.git ancestor — what an IDE does), so the common case is just --entry.
      const base = req.root ? resolve(req.root) : process.cwd();
      const entryFile = isAbsolute(req.entry.file) ? req.entry.file : resolve(base, req.entry.file);
      const root = req.root ? resolve(req.root) : findProjectRoot(entryFile);
      const graph = await provider.callGraph({ ...req.entry, file: entryFile }, {
        root,
        maxDepth: req.maxDepth,
        includeExternal: req.includeExternal ?? false,
        maxNodes: req.maxNodes ?? MAX_NODES,
        server: req.server,
      });
      data = new TraceData({ graph });
      if (graph.stats.truncated) {
        diagnostics.push(Diagnostic.warn("GRAPH_TRUNCATED", `graph truncated at depth ${req.maxDepth} — raise --depth for more, or pick a more specific entry`));
      }
    } catch (e: any) {
      diagnostics.push(Diagnostic.error("CODEGRAPH_FAILED", String(e?.message ?? e).split("\n")[0]));
      log.error("call graph failed", { provider: provider.name, err: e });
    }

    // `ok` derives from the diagnostics: a CODEGRAPH_FAILED error flips it false, GRAPH_TRUNCATED (warn) doesn't.
    return this.envelope({
      command: `graph.${provider.name}`,
      data,
      diagnostics,
      args: req.args ?? {},
      startedAtMs,
    });
  }

  /** Human view: the call graph unrolled into a flow tree, with shared callees, cycles and externals marked. */
  render(trace: Trace): string {
    const graph = trace.data.graph as CodeGraph | undefined;
    const guard = this.emptyRender(trace, !!graph?.nodes?.length, "graph", "no nodes");
    return guard !== undefined ? guard : renderGraphTree(graph!);
  }

  /** HTML view: the same call graph as an interactive node-and-edge diagram (see {@link renderGraphHtml}). */
  renderHtml(trace: Trace): string {
    return renderGraphHtml(trace);
  }
}
