import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
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

interface DepNode { id: string; label: string; loc: { file: string }; }
interface DepEdge { from: string; to: string; kind: string; }
export interface DepGraph { entry?: string; nodes: DepNode[]; edges: DepEdge[]; stats: { modules: number; edges: number; circular: number }; }

/**
 * DepsCommand — the `static deps` analysis: a module-import graph via `madge --json`. A {@link
 * ShellAnalysisCommand}: the base owns the run/envelope/failure skeleton; this class supplies the madge call
 * ({@link invocation}) and the JSON → Graph normalization ({@link interpret}). The payload conforms to the
 * schema `Graph` $def (nodes/edges) under `data.deps`, distinct from `data.graph` (which is the *call* graph).
 */
export class DepsCommand extends ShellAnalysisCommand<DepsRequest> {
  protected readonly tool = "madge";
  protected readonly command = "deps.madge";
  protected readonly errorCode = "DEPS_FAILED";
  protected readonly component = "deps";

  protected invocation(req: DepsRequest): ToolInvocation {
    const cwd = req.root ?? process.cwd();
    const extensions = req.extensions ?? DEFAULT_EXTENSIONS;
    // A tsconfig lets madge resolve path aliases (e.g. `@/foo`); auto-detect one so the common case needs no flag.
    const tsConfig = req.tsConfig ?? findTsConfig(cwd, req.entry);
    const argv = [
      "--json", "--extensions", extensions,
      ...(tsConfig ? ["--ts-config", tsConfig] : []),
      ...(req.exclude ? ["--exclude", req.exclude] : []),
      req.entry,
    ];
    return { argv, cwd, args: { ...(req.args ?? {}), extensions, ...(tsConfig ? { tsConfig } : {}), ...(req.exclude ? { exclude: req.exclude } : {}) } };
  }

  protected interpret(res: ToolRun, req: DepsRequest): AnalysisOutcome {
    let map: Record<string, string[]>;
    try { map = JSON.parse(res.stdout) as Record<string, string[]>; }
    catch (e: any) { throw new Error(`could not parse madge output: ${String(e?.message ?? e).split("\n")[0]}`); }
    const deps = DepsCommand.toGraph(map, req.entry);
    const diagnostics = deps.stats.circular
      ? [Diagnostic.warn("DEPS_CIRCULAR", `${deps.stats.circular} circular dependency group(s) — run with madge --circular for the chains`)]
      : [];
    return { data: new TraceData({ deps }), diagnostics };
  }

  /** Normalize madge's `{ module: [imports] }` JSON into the schema Graph shape + a circular-group count (SCCs > 1). */
  static toGraph(map: Record<string, string[]>, entry?: string): DepGraph {
    const nodes: DepNode[] = Object.keys(map).map((id) => ({ id, label: id, loc: { file: id } }));
    const edges: DepEdge[] = [];
    for (const [from, deps] of Object.entries(map)) for (const to of deps) edges.push({ from, to, kind: "imports" });
    return { entry, nodes, edges, stats: { modules: nodes.length, edges: edges.length, circular: countCircularGroups(map) } };
  }

  /** Human view: one block per module with its imports, cycles flagged in the header. */
  render(trace: Trace): string {
    const maybe = trace.data.deps as DepGraph | undefined;
    const guard = this.emptyRender(trace, !!maybe?.nodes?.length, "deps", "no modules");
    if (guard !== undefined) return guard; // no payload → guard is the rendered line; else the graph is present
    const g = maybe!;
    const adj = new Map<string, string[]>();
    for (const e of g.edges) (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    const lines = [
      `deps — ${g.stats.modules} modules · ${g.stats.edges} imports` + (g.stats.circular ? ` · ${g.stats.circular} circular` : ""),
      "",
    ];
    for (const id of g.nodes.map((n) => n.id).sort()) {
      const outs = (adj.get(id) ?? []).sort();
      lines.push(id);
      outs.forEach((to, i) => lines.push(`  ${i === outs.length - 1 ? "└─" : "├─"} ${to}`));
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
  let dir = isAbsolute(entry) ? entry : resolve(cwd, entry);
  // entry may be a file or a directory; start the walk from its containing directory either way.
  if (existsSync(dir) && !existsSync(join(dir, "tsconfig.json"))) dir = dirname(dir);
  const stop = parse(dir).root;
  for (let d = dir; ; d = dirname(d)) {
    const candidate = join(d, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (d === stop) return undefined;
  }
}

/** Count strongly-connected components of size > 1 (Tarjan) — each is a circular-import group. */
function countCircularGroups(map: Record<string, string[]>): number {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let idx = 0;
  let groups = 0;
  const nodes = new Set<string>(Object.keys(map));
  for (const deps of Object.values(map)) for (const d of deps) nodes.add(d);

  const strongconnect = (v: string): void => {
    index.set(v, idx); low.set(v, idx); idx++;
    stack.push(v); onStack.add(v);
    for (const w of map[v] ?? []) {
      if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      let size = 0;
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); size++; } while (w !== v);
      if (size > 1) groups++;
    }
  };

  for (const v of nodes) if (!index.has(v)) strongconnect(v);
  return groups;
}
