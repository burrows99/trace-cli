/**
 * CodeGraphProvider — the static-analysis abstraction the `graph` command depends on (Dependency Inversion).
 * The command asks for "the outgoing-call graph rooted at this entry"; it never talks to a concrete analyzer
 * directly. The shipped implementation drives a language server over LSP (LspCodeGraphProvider); swapping in
 * another analyzer (e.g. an SCIP indexer) is a new implementation of this interface, not a command change —
 * the same plug/factory shape already used by SessionStore, ArtifactStore and ProtocolDriver.
 *
 * Why a call *graph* (nodes + edges) and not a tree: a function reached from two places, or a recursive
 * cycle, is one node with two in-edges — not a duplicated/ infinite subtree. The normalized graph dedupes
 * naturally; the human "flow tree" is a traversal over it (see GraphCommand), where shared callees and
 * back-edges are marked rather than re-expanded. The node/edge shapes mirror the `Graph`/`SourceLocation` $defs already
 * declared in the output schema so consumers learn one vocabulary.
 */
import { SourceLocation } from "../domain/SourceLocation.js";

/** Where to start: a file plus a 1-based line (optionally a 1-based column), or a symbol name. */
export interface EntryReference {
  file: string;
  line?: number;
  column?: number;
  symbol?: string;
}

export namespace EntryReference {
  /** Parse a CLI `--entry`: `file@symbol` → {file, symbol}; `file:line[:column]` → {file, line, column?}; else {file}. */
  export function parse(reference: string): EntryReference {
    const atIndex = reference.indexOf("@");
    if (atIndex >= 0) return { file: reference.slice(0, atIndex), symbol: reference.slice(atIndex + 1) };
    const location = SourceLocation.parse(reference);
    if (location?.line) return { file: location.file, line: location.line, ...(location.column != null ? { column: location.column } : {}) };
    return { file: reference };
  }
}

/** Knobs for one call-graph build. `root` scopes the project; depth/node caps keep the graph bounded + fast. */
export interface CallGraphOptions {
  /** Project root: the LSP workspace folder, and the base used to relativize paths. */
  root: string;
  /** Max call depth expanded outward from the entry (the entry is depth 0). */
  maxDepth: number;
  /** Expand into external (node_modules / outside-root) callees instead of leaving them as leaves. */
  includeExternal: boolean;
  /** Hard cap on node count; the build stops expanding once reached (stats.truncated flips true). */
  maxNodes: number;
  /** LSP server launch command (e.g. "gopls", "pyright --stdio"); defaults to the bundled TS server. */
  server?: string;
}

/**
 * Knobs for a whole-directory/repo map: discover every source file under `root`, then ask the server for the
 * full picture of each — symbols (containment), calls, and inheritance — rather than walking out from one entry.
 */
export interface RepoGraphOptions {
  /** Directory to map (already resolved to a real dir): the LSP workspace folder + relativization base. */
  root: string;
  /** File extensions to scan; defaults to the bundled TS server's set. Discovery skips node_modules/dist/.git. */
  extensions?: string[];
  /** Hard cap on files opened — keeps a huge repo bounded (stats.truncated flips true when hit). */
  maxFiles: number;
  /** Hard cap on node count, same role as in {@link CallGraphOptions}. */
  maxNodes: number;
  /** Add `extends`/`implements` edges via the server's type hierarchy. Default on; skipped if unsupported. */
  inheritance?: boolean;
  /** Add `references` edges (who-uses-each-symbol). Heavy (O(symbols × refs)) — opt-in, default off. */
  references?: boolean;
  /** Keep edges to external (node_modules / outside-root) symbols, as leaf nodes. Default false. */
  includeExternal?: boolean;
  /** LSP server launch command; defaults to the bundled TS server. */
  server?: string;
}

/** Scope of a node's source file: in the workspace, or an external dependency / outside the root. */
export type NodeScope = "local" | "external";

/** A function/method node. `id` is stable (`relpath:line:column`); shapes align with the schema `Graph`/`SourceLocation` $defs. */
export interface GraphNode {
  id: string;
  kind: string;   // TS ScriptElementKind: "function" | "method" | "local function" | …
  label: string;  // symbol name, prefixed with its container when known
  location: { file: string; line: number; column?: number; endLine?: number };
  scope: NodeScope;
  external?: boolean; // true for scope !== "local" — convenience flag mirroring the schema
}

/** A directed edge between two nodes. `weight` is the number of distinct sites (call sites / reference sites). */
export interface GraphEdge {
  from: string;
  to: string;
  kind: string;   // "calls" | "contains" | "extends" | "implements" | "references"
  weight?: number;
}

/**
 * The built graph: a normalized node/edge set plus build provenance + stats. `mode` says how it was built —
 * "rooted" is the outward call walk from one `entry` (the entry node id); "repo" is the whole-directory map,
 * where there is no single entry (`entry` is "") and edges carry every relationship kind, not just calls.
 */
export interface CodeGraph {
  provider: string;
  root: string;
  mode: "rooted" | "repo";
  entry: string;  // node id of the entry function ("" for a repo map — no single root)
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodes: number; edges: number; maxDepth: number; truncated: boolean; external: number;
    files?: number;                          // repo mode: how many source files were mapped
    edgeKinds?: Record<string, number>;      // repo mode: count per relationship kind (contains/calls/extends/…)
  };
  /** Human-readable notes about a partial build (e.g. a relationship the server couldn't provide) → warn diagnostics. */
  notes?: string[];
}

/** Result of probing whether a provider can run here (binary present / library resolvable). */
export interface ProviderAvailability {
  ok: boolean;
  detail?: string;
}

export interface CodeGraphProvider {
  /** Stable provider id used by the factory, `--provider`, and the envelope command (`graph.<name>`). */
  readonly name: string;
  /** Can this provider run against `root`? (e.g. its CLI is installed, or its library resolves.) Never throws. */
  isAvailable(root: string): Promise<ProviderAvailability>;
  /** Build the outgoing-call graph rooted at `entry`. Throws with a clear message on unresolvable input. */
  callGraph(entry: EntryReference, opts: CallGraphOptions): Promise<CodeGraph>;
  /** Map a whole directory: every symbol the server reports, with containment + calls + inheritance edges. */
  repoGraph(opts: RepoGraphOptions): Promise<CodeGraph>;
}
