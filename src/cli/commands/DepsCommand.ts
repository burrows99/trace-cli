import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { Code } from "../../shared/codes.js";
import type { ToolRun } from "../../shared/runTool.js";
import { ShellAnalysisCommand, type AnalysisOutcome, type ToolInvocation } from "./ShellAnalysisCommand.js";
import { GraphView } from "./GraphView.js";

// madge defaults to scanning js/jsx only — on a TS/NestJS repo that finds zero modules. Cover the common
// source extensions by default so `deps` works on TS, TSX and ESM/CJS projects without extra flags.
const DEFAULT_EXTENSIONS = "ts,tsx,js,jsx,mjs,cjs";

export interface DepsRequest {
  entry: string;          // a file or directory to analyze
  root?: string;          // cwd for madge (default: process.cwd())
  extensions?: string;    // comma-separated file extensions madge should scan (default: DEFAULT_EXTENSIONS)
  tsConfig?: string;      // tsconfig for path-alias resolution (default: auto-detected near root/entry)
  exclude?: string;       // regexp of module paths to drop (madge --exclude), e.g. build output like "(^|/)dist/"
  args?: Record<string, unknown>;
}

interface DepNode { id: string; label: string; location: { file: string }; }
interface DepEdge { from: string; to: string; kind: string; }
export interface DepGraph { entry?: string; nodes: DepNode[]; edges: DepEdge[]; stats: { modules: number; edges: number; circular: number }; }

/**
 * DepsCommand — the `deps` analysis: a module-import graph via `madge --json`. A {@link
 * ShellAnalysisCommand}: the base owns the run/envelope/failure skeleton; this class supplies the madge call
 * ({@link invocation}) and the JSON → Graph normalization ({@link interpret}). The payload conforms to the
 * schema `Graph` $def (nodes/edges) under `data.deps`, distinct from `data.graph` (which is the *call* graph).
 */
export class DepsCommand extends ShellAnalysisCommand<DepsRequest> {
  protected readonly tool = "madge";
  protected readonly command = "deps.madge";
  protected readonly errorCode = Code.DEPS_FAILED;
  protected readonly component = "deps";

  protected invocation(request: DepsRequest): ToolInvocation {
    const cwd = request.root ?? process.cwd();
    const extensions = request.extensions ?? DEFAULT_EXTENSIONS;
    // A tsconfig lets madge resolve path aliases (e.g. `@/foo`); auto-detect one so the common case needs no flag.
    const tsConfig = request.tsConfig ?? findTsConfig(cwd, request.entry);
    const argv = [
      "--json", "--extensions", extensions,
      ...(tsConfig ? ["--ts-config", tsConfig] : []),
      ...(request.exclude ? ["--exclude", request.exclude] : []),
      request.entry,
    ];
    return { argv, cwd, args: { ...(request.args ?? {}), extensions, ...(tsConfig ? { tsConfig } : {}), ...(request.exclude ? { exclude: request.exclude } : {}) } };
  }

  protected interpret(toolRun: ToolRun, request: DepsRequest): AnalysisOutcome {
    let moduleImports: Record<string, string[]>;
    try { moduleImports = JSON.parse(toolRun.stdout) as Record<string, string[]>; }
    catch (error: any) { throw new Error(`could not parse madge output: ${String(error?.message ?? error).split("\n")[0]}`); }
    const deps = DepsCommand.toGraph(moduleImports, request.entry);
    const diagnostics = deps.stats.circular
      ? [Diagnostic.warn(Code.DEPS_CIRCULAR, `${deps.stats.circular} circular dependency group(s) — run with madge --circular for the chains`)]
      : [];
    return { data: new TraceData({ deps }), diagnostics };
  }

  /** Normalize madge's `{ module: [imports] }` JSON into the schema Graph shape + a circular-group count (SCCs > 1). */
  static toGraph(moduleImports: Record<string, string[]>, entry?: string): DepGraph {
    const nodes: DepNode[] = Object.keys(moduleImports).map((id) => ({ id, label: id, location: { file: id } }));
    const edges: DepEdge[] = [];
    for (const [from, imports] of Object.entries(moduleImports)) for (const to of imports) edges.push({ from, to, kind: "imports" });
    return { entry, nodes, edges, stats: { modules: nodes.length, edges: edges.length, circular: countCircularGroups(moduleImports) } };
  }

  /** Human view: one block per module with its imports, cycles flagged in the header. */
  render(trace: Trace): string {
    const maybeGraph = trace.data.deps as DepGraph | undefined;
    const guard = this.emptyRender(trace, !!maybeGraph?.nodes?.length, "deps", "no modules");
    if (guard !== undefined) return guard; // no payload → guard is the rendered line; else the graph is present
    const graph = maybeGraph!;
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) (adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from)!).push(edge.to);
    const lines = [
      `deps — ${graph.stats.modules} modules · ${graph.stats.edges} imports` + (graph.stats.circular ? ` · ${graph.stats.circular} circular` : ""),
      "",
    ];
    for (const id of graph.nodes.map((node) => node.id).sort()) {
      const outgoing = (adjacency.get(id) ?? []).sort();
      lines.push(id);
      outgoing.forEach((to, index) => lines.push(`  ${index === outgoing.length - 1 ? "└─" : "├─"} ${to}`));
    }
    return lines.join("\n");
  }

  /** HTML view: the whole module graph as an interactive node-and-edge diagram (see {@link GraphView.depsHtml}). */
  renderHtml(trace: Trace): string {
    return GraphView.depsHtml(trace);
  }
}

/**
 * Find the nearest `tsconfig.json` for madge's `--ts-config` (path-alias resolution): check the madge cwd
 * first, then walk up from the entry's directory to the filesystem root. Returns undefined when none exists
 * (a plain JS project) — madge then runs without alias resolution, which is correct for non-TS code.
 */
function findTsConfig(cwd: string, entry: string): string | undefined {
  const atCwd = join(cwd, "tsconfig.json");
  if (existsSync(atCwd)) return atCwd;
  let directory = isAbsolute(entry) ? entry : resolve(cwd, entry);
  // entry may be a file or a directory; start the walk from its containing directory either way.
  if (existsSync(directory) && !existsSync(join(directory, "tsconfig.json"))) directory = dirname(directory);
  const rootDirectory = parse(directory).root;
  for (let currentDirectory = directory; ; currentDirectory = dirname(currentDirectory)) {
    const candidate = join(currentDirectory, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (currentDirectory === rootDirectory) return undefined;
  }
}

/** Count strongly-connected components of size > 1 (Tarjan) — each is a circular-import group. */
function countCircularGroups(moduleImports: Record<string, string[]>): number {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let nextIndex = 0;
  let groups = 0;
  const nodes = new Set<string>(Object.keys(moduleImports));
  for (const dependencies of Object.values(moduleImports)) for (const dependency of dependencies) nodes.add(dependency);

  const strongconnect = (vertex: string): void => {
    index.set(vertex, nextIndex); lowLink.set(vertex, nextIndex); nextIndex++;
    stack.push(vertex); onStack.add(vertex);
    for (const neighborVertex of moduleImports[vertex] ?? []) {
      if (!index.has(neighborVertex)) { strongconnect(neighborVertex); lowLink.set(vertex, Math.min(lowLink.get(vertex)!, lowLink.get(neighborVertex)!)); }
      else if (onStack.has(neighborVertex)) lowLink.set(vertex, Math.min(lowLink.get(vertex)!, index.get(neighborVertex)!));
    }
    if (lowLink.get(vertex) === index.get(vertex)) {
      let size = 0;
      let poppedVertex: string;
      do { poppedVertex = stack.pop()!; onStack.delete(poppedVertex); size++; } while (poppedVertex !== vertex);
      if (size > 1) groups++;
    }
  };

  for (const vertex of nodes) if (!index.has(vertex)) strongconnect(vertex);
  return groups;
}
