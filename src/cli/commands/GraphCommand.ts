import { isAbsolute, resolve } from "node:path";

import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { logger } from "../../shared/logger.js";
import { Code } from "../../shared/codes.js";
import { findProjectRoot, findProjectRootFrom } from "../../shared/projectRoot.js";
import { createCodeGraphProvider } from "../../codegraph/createCodeGraphProvider.js";
import type { CodeGraph, EntryReference } from "../../codegraph/CodeGraphProvider.js";
import { resolveRepoRoot } from "../../codegraph/sourceFiles.js";
import { TraceCommand } from "./TraceCommand.js";
import { GraphView } from "./GraphView.js";

const log = logger.child({ component: "graph" });
const MAX_NODES = 2000; // internal safety cap on graph size; --depth is the user-facing size knob
const MAX_FILES = 800;  // internal safety cap on a repo map's breadth; --max-files is the user-facing knob

export interface GraphRequest {
  entry?: EntryReference;    // rooted mode: where the call walk starts. Absent (or `repo`) → a whole-directory map.
  repo?: boolean;            // true → map a directory (root) instead of walking calls out from `entry`
  provider?: string;
  root?: string;             // rooted: workspace root (auto-detected from entry when absent). repo: the dir to map.
  maxDepth: number;
  includeExternal?: boolean; // default false — externals (node_modules / outside-root) shown as leaves
  maxFiles?: number;         // repo: default MAX_FILES
  inheritance?: boolean;     // repo: default true (skipped if the server lacks type hierarchy)
  maxNodes?: number;         // default MAX_NODES — internal safety cap, not a user knob
  server?: string;
  args?: Record<string, unknown>;
}

/**
 * GraphCommand — orchestrates a static code-graph build and normalizes it into one Trace envelope (`data.graph`).
 * Two modes share the provider + envelope: a `rooted` outgoing-call walk from an `--entry` function, and a `repo`
 * map of a whole directory (every symbol, with containment + calls + inheritance). The provider is the injected
 * collaborator (Dependency Inversion); a resolution/analysis failure becomes an error diagnostic on a still-
 * well-formed envelope, matching how the run command surfaces engine failures — an agent always gets a Trace.
 */
export class GraphCommand extends TraceCommand<GraphRequest> {
  async run(request: GraphRequest): Promise<Trace> {
    const startedAtMs = this.started();
    const provider = createCodeGraphProvider(request.provider);
    const diagnostics: Diagnostic[] = [];
    let data = new TraceData({});

    try {
      if (request.repo || !request.entry) {
        // Repo map: an explicit --root/dir is mapped as given; with neither, detect the nearest project root by
        // walking UP from cwd (tsconfig/package.json/.git) — so a bare `trace graph` in a subdir maps the whole
        // project, not just that subdir. `resolveRepoRoot` keeps an explicit file argument pointing at its root.
        const root = request.root ? resolveRepoRoot(request.root) : findProjectRootFrom(process.cwd());
        const graph = await provider.repoGraph({
          root,
          maxFiles: request.maxFiles ?? MAX_FILES,
          maxNodes: request.maxNodes ?? MAX_NODES,
          includeExternal: request.includeExternal ?? false,
          inheritance: request.inheritance,
          server: request.server,
        });
        data = new TraceData({ graph });
        if (graph.stats.truncated) {
          diagnostics.push(Diagnostic.warn(Code.GRAPH_TRUNCATED, `repo map truncated (${graph.stats.files} files, ${graph.stats.nodes} symbols) — narrow with --entry <subdir>, or raise --max-files`));
        }
        // A relationship the server couldn't provide (e.g. no type hierarchy → no extends/implements) → a warn, so
        // the missing edges are legible in the envelope instead of looking like the repo simply has no inheritance.
        for (const note of graph.notes ?? []) diagnostics.push(Diagnostic.warn(Code.GRAPH_DEGRADED, note));
      } else {
        // Rooted call walk: resolve the entry to an absolute path, then auto-detect the project root from it when
        // --root is absent (nearest tsconfig/package.json/.git ancestor), so the common case is just --entry.
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
      }
    } catch (error: any) {
      diagnostics.push(Diagnostic.error(Code.CODEGRAPH_FAILED, String(error?.message ?? error).split("\n")[0]));
      log.error("code graph failed", { code: Code.CODEGRAPH_FAILED, provider: provider.name, err: error });
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

  /** Human view: a rooted call walk renders as a flow tree; a repo map renders as a per-file symbol outline. */
  render(trace: Trace): string {
    const graph = trace.data.graph as CodeGraph | undefined;
    const guard = this.emptyRender(trace, !!graph?.nodes?.length, "graph", "no nodes");
    if (guard !== undefined) return guard;
    return graph!.mode === "repo" ? GraphView.repoMap(graph!) : GraphView.tree(graph!);
  }

  /** HTML view: the same call graph as an interactive node-and-edge diagram (see {@link GraphView.callGraphHtml}). */
  renderHtml(trace: Trace): string {
    return GraphView.callGraphHtml(trace);
  }
}
