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
 * back-edges are marked rather than re-expanded. The node/edge shapes mirror the `Graph`/`Loc` $defs already
 * declared in the output schema so consumers learn one vocabulary.
 */

/** Where to start: a file plus a 1-based line (optionally a 1-based col), or a symbol name. */
export interface EntryRef {
  file: string;
  line?: number;
  col?: number;
  symbol?: string;
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

/** Scope of a node's source file: in the workspace, or an external dependency / outside the root. */
export type NodeScope = "local" | "external";

/** A function/method node. `id` is stable (`relpath:line:col`); shapes align with the schema `Graph`/`Loc` $defs. */
export interface GraphNode {
  id: string;
  kind: string;   // TS ScriptElementKind: "function" | "method" | "local function" | …
  label: string;  // symbol name, prefixed with its container when known
  loc: { file: string; line: number; col?: number; endLine?: number };
  scope: NodeScope;
  external?: boolean; // true for scope !== "local" — convenience flag mirroring the schema
}

/** A directed call edge. `weight` is the number of distinct call sites from→to. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: string;   // "calls"
  weight?: number;
}

/** The built call graph: a normalized node/edge set rooted at `entry`, plus build provenance + stats. */
export interface CodeGraph {
  provider: string;
  root: string;
  entry: string;  // node id of the entry function
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { nodes: number; edges: number; maxDepth: number; truncated: boolean; external: number };
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
  callGraph(entry: EntryRef, opts: CallGraphOptions): Promise<CodeGraph>;
}
