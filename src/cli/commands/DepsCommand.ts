import { Trace, TraceData } from "../../domain/Trace.js";
import { Diagnostic } from "../../domain/Diagnostic.js";
import { logger } from "../../shared/logger.js";
import { runTool } from "../../shared/runTool.js";
import { TraceCommand } from "./TraceCommand.js";

const log = logger.child({ component: "deps" });

export interface DepsRequest {
  entry: string;          // a file or directory to analyze
  root?: string;          // cwd for madge (default: process.cwd())
  args?: Record<string, unknown>;
}

interface DepNode { id: string; label: string; loc: { file: string }; }
interface DepEdge { from: string; to: string; kind: string; }
export interface DepGraph { entry?: string; nodes: DepNode[]; edges: DepEdge[]; stats: { modules: number; edges: number; circular: number }; }

/**
 * DepsCommand — the `static deps` analysis: a module-import graph via `madge --json`. Mirrors GraphCommand
 * (the call graph): own the use-case + the envelope, shell out to the analyzer, and a tool/parse failure
 * becomes an error diagnostic on a still-well-formed Trace. The payload conforms to the schema `Graph` $def
 * (nodes/edges) under `data.deps`, distinct from `data.graph` (which is the *call* graph).
 */
export class DepsCommand extends TraceCommand<DepsRequest> {
  async run(req: DepsRequest): Promise<Trace> {
    const startedAtMs = this.started();
    const diagnostics: Diagnostic[] = [];
    let data = new TraceData({});

    const res = await runTool("madge", ["--json", req.entry], { cwd: req.root ?? process.cwd() });
    if (!res.ok) {
      diagnostics.push(Diagnostic.error("DEPS_FAILED", res.error ?? `madge exited ${res.code}`));
      log.error("madge failed", { entry: req.entry, err: res.error });
    } else {
      try {
        const deps = DepsCommand.toGraph(JSON.parse(res.stdout) as Record<string, string[]>, req.entry);
        data = new TraceData({ deps });
        if (deps.stats.circular) {
          diagnostics.push(Diagnostic.warn("DEPS_CIRCULAR", `${deps.stats.circular} circular dependency group(s) — run with madge --circular for the chains`));
        }
      } catch (e: any) {
        diagnostics.push(Diagnostic.error("DEPS_FAILED", `could not parse madge output: ${String(e?.message ?? e).split("\n")[0]}`));
      }
    }

    return this.envelope({ command: "deps.madge", data, diagnostics, args: req.args ?? {}, startedAtMs });
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
    const g = trace.data.deps as DepGraph | undefined;
    if (!g || !g.nodes?.length) {
      const err = trace.diagnostics.find((d) => d.level === "error");
      return err ? `deps — failed: ${err.message}` : "deps — no modules";
    }
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
