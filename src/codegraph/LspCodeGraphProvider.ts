import { readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  CallHierarchyPrepareRequest,
  CallHierarchyOutgoingCallsRequest,
  TypeHierarchyPrepareRequest,
  TypeHierarchySupertypesRequest,
  SymbolKind,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type DocumentSymbol,
  type Position,
  type Range,
  type SymbolInformation,
  type TypeHierarchyItem,
} from "vscode-languageserver-protocol";

import type { CallGraphOptions, CodeGraph, CodeGraphProvider, EntryReference, GraphEdge, GraphNode, NodeScope, ProviderAvailability, RepoGraphOptions } from "./CodeGraphProvider.js";
import { LspClient, resolveServer, defaultTsServer } from "./LspClient.js";
import { discoverSourceFiles } from "./sourceFiles.js";
import { logger } from "../shared/logger.js";
import { sleep } from "../shared/sleep.js";

const log = logger.child({ component: "codegraph", provider: "lsp" });

/**
 * LspCodeGraphProvider — the official, language-agnostic provider. It drives a standard language server over
 * the Language Server Protocol (call hierarchy, standardized since LSP 3.16): `textDocument/prepareCallHierarchy`
 * resolves the entry, `callHierarchy/outgoingCalls` walks the calls out of it — the exact requests an IDE's
 * "Show Call Hierarchy" issues. The server owns all analysis and project loading (tsconfig, references, deps),
 * so there's no bespoke host here. Default server is the bundled `typescript-language-server`; point `--server`
 * at any other (`gopls`, `rust-analyzer`, `pyright --stdio`, `clangd`) to graph that language instead.
 */
export class LspCodeGraphProvider implements CodeGraphProvider {
  readonly name = "lsp";

  async isAvailable(): Promise<ProviderAvailability> {
    try {
      defaultTsServer();
      return { ok: true, detail: "typescript-language-server (LSP, default)" };
    } catch (error) {
      return { ok: false, detail: String(error) };
    }
  }

  async callGraph(entry: EntryReference, options: CallGraphOptions): Promise<CodeGraph> {
    const root = resolve(options.root);
    const rootUri = pathToFileURL(root + "/").toString();
    const rootPath = fileURLToPath(rootUri).replace(/\\/g, "/");
    const absoluteFile = isAbsolute(entry.file) ? entry.file : resolve(root, entry.file);
    const fileUri = pathToFileURL(absoluteFile).toString();

    const client = new LspClient(resolveServer(options.server, absoluteFile));
    try {
      const initializeResult = await client.initialize({
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "root" }],
        capabilities: {
          textDocument: {
            callHierarchy: { dynamicRegistration: false },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        },
      });
      if (!initializeResult.capabilities.callHierarchyProvider) {
        throw new Error("language server does not support call hierarchy (no callHierarchyProvider capability)");
      }

      const opened = new Set<string>();
      const open = (uri: string): void => {
        if (opened.has(uri)) return;
        let text: string;
        try { text = readFileSync(fileURLToPath(uri), "utf8"); } catch { return; }
        client.notify(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: languageIdFor(uri), version: 1, text } });
        opened.add(uri);
      };
      open(fileUri);

      const position = await this.#resolvePosition(client, fileUri, entry);
      if (!position) {
        const entryDescription = entry.symbol ? `symbol "${entry.symbol}"` : `a function on line ${entry.line}`;
        throw new Error(`could not find ${entryDescription} in ${relativePath(root, absoluteFile)}`);
      }

      // tsserver may still be loading the project on the first request; retry prepare a few times.
      let rootItem: CallHierarchyItem | undefined;
      for (let attempt = 0; attempt < 4 && !rootItem; attempt++) {
        if (attempt) await sleep(300);
        const prepared = await client.request<CallHierarchyItem[] | null>(CallHierarchyPrepareRequest.type, { textDocument: { uri: fileUri }, position });
        rootItem = prepared?.[0];
      }
      if (!rootItem) throw new Error(`no callable resolved at ${relativePath(root, absoluteFile)} — point --entry at a function/method`);

      const scopeOf = (uri: string): NodeScope => {
        const filePath = fileURLToPath(uri).replace(/\\/g, "/");
        return filePath.startsWith(rootPath) && !filePath.includes("/node_modules/") ? "local" : "external";
      };
      const toNode = (item: CallHierarchyItem): GraphNode => {
        const file = relativePath(root, fileURLToPath(item.uri));
        const start = item.selectionRange.start;
        const scope = scopeOf(item.uri);
        const node: GraphNode = {
          id: `${file}:${start.line + 1}:${start.character + 1}`,
          kind: symbolKindName(item.kind),
          label: item.name,
          location: { file, line: start.line + 1, column: start.character + 1, endLine: item.range.end.line + 1 },
          scope,
        };
        if (scope !== "local") node.external = true;
        return node;
      };

      // BFS the outgoing-call hierarchy. The graph dedupes nodes/edges; `expanded` also terminates recursion.
      const nodes = new Map<string, GraphNode>();
      const edges: GraphEdge[] = [];
      const edgeKeys = new Set<string>();
      const expanded = new Set<string>();
      const itemOf = new Map<string, CallHierarchyItem>();
      let truncated = false;

      const register = (item: CallHierarchyItem): GraphNode => {
        const node = toNode(item);
        if (!nodes.has(node.id)) { nodes.set(node.id, node); itemOf.set(node.id, item); }
        return nodes.get(node.id)!;
      };

      const rootNode = register(rootItem);
      const queue: Array<{ id: string; depth: number }> = [{ id: rootNode.id, depth: 0 }];
      while (queue.length) {
        const { id, depth } = queue.shift()!;
        if (expanded.has(id)) continue;
        expanded.add(id);
        const node = nodes.get(id)!;
        if (node.scope === "external" && !options.includeExternal) continue; // leaf: don't expand into deps
        if (depth >= options.maxDepth) { truncated = true; continue; }
        if (nodes.size >= options.maxNodes) { truncated = true; continue; }

        const item = itemOf.get(id)!;
        open(item.uri);
        let outgoing: CallHierarchyOutgoingCall[] | null = null;
        try { outgoing = await client.request<CallHierarchyOutgoingCall[] | null>(CallHierarchyOutgoingCallsRequest.type, { item }); } catch (error) {
          log.debug("outgoing calls failed", { id, err: String(error) });
        }
        for (const outgoingCall of outgoing ?? []) {
          const child = register(outgoingCall.to);
          const edgeKey = `${id}->${child.id}`;
          if (!edgeKeys.has(edgeKey)) { edgeKeys.add(edgeKey); edges.push({ from: id, to: child.id, kind: "calls", weight: outgoingCall.fromRanges?.length }); }
          if ((child.scope === "local" || options.includeExternal) && !expanded.has(child.id)) queue.push({ id: child.id, depth: depth + 1 });
        }
      }

      const nodeList = [...nodes.values()];
      const graph: CodeGraph = {
        provider: this.name,
        root,
        mode: "rooted",
        entry: rootNode.id,
        nodes: nodeList,
        edges,
        stats: { nodes: nodeList.length, edges: edges.length, maxDepth: options.maxDepth, truncated, external: nodeList.filter((node) => node.external).length },
      };
      log.info("call graph built", { entry: graph.entry, nodes: graph.stats.nodes, edges: graph.stats.edges, truncated });
      return graph;
    } finally {
      await client.dispose();
    }
  }

  /**
   * repoGraph — the whole-directory map. Discovers every source file under `root`, opens them all, then asks the
   * server for the full structure of each: `documentSymbol` for containment (file → class → method/field) and the
   * node kinds, `callHierarchy/outgoingCalls` per callable for `calls` edges, and `typeHierarchy/supertypes` per
   * class/interface for `extends`/`implements` edges. Each pass is capability-guarded, so it degrades gracefully on
   * servers that lack call/type hierarchy. The result is the same normalized {@link CodeGraph} the rooted walk
   * produces (one schema, one renderer), tagged `mode: "repo"` with no single entry.
   */
  async repoGraph(options: RepoGraphOptions): Promise<CodeGraph> {
    const root = resolve(options.root);
    const rootUri = pathToFileURL(root + "/").toString();
    const rootPath = fileURLToPath(rootUri).replace(/\\/g, "/");
    const discovery = discoverSourceFiles(root, { extensions: options.extensions, maxFiles: options.maxFiles });
    if (!discovery.files.length) throw new Error(`no source files found under ${relativePath(process.cwd(), root)} (checked the default source extensions)`);

    const client = new LspClient(resolveServer(options.server, discovery.files[0]));
    try {
      const initializeResult = await client.initialize({
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "root" }],
        capabilities: {
          textDocument: {
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            callHierarchy: { dynamicRegistration: false },
            typeHierarchy: { dynamicRegistration: false },
          },
        },
      });
      const capabilities = initializeResult.capabilities;
      const hasCallHierarchy = !!capabilities.callHierarchyProvider;
      const hasTypeHierarchy = !!capabilities.typeHierarchyProvider;

      const opened = new Set<string>();
      const open = (uri: string): void => {
        if (opened.has(uri)) return;
        let text: string;
        try { text = readFileSync(fileURLToPath(uri), "utf8"); } catch { return; }
        client.notify(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: languageIdFor(uri), version: 1, text } });
        opened.add(uri);
      };
      for (const file of discovery.files) open(pathToFileURL(file).toString());

      const scopeOf = (uri: string): NodeScope => {
        const filePath = fileURLToPath(uri).replace(/\\/g, "/");
        return filePath.startsWith(rootPath) && !filePath.includes("/node_modules/") ? "local" : "external";
      };

      const nodes = new Map<string, GraphNode>();
      const edges: GraphEdge[] = [];
      const edgeKeys = new Set<string>();
      const notes: string[] = [];
      let truncated = discovery.truncated;
      const atNodeCap = (): boolean => nodes.size >= options.maxNodes;

      const addEdge = (from: string, to: string, kind: GraphEdge["kind"], weight?: number): void => {
        if (from === to && kind === "contains") return; // a symbol can't contain itself
        const key = `${kind}:${from}->${to}`;
        if (edgeKeys.has(key)) return;
        edgeKeys.add(key);
        edges.push({ from, to, kind, ...(weight ? { weight } : {}) });
      };

      // Add (or fetch) a node for an LSP hierarchy item (call/type). Local items always join; external ones only
      // when asked, so the map stays inside the repo by default. Returns the node id, or null when skipped.
      const ensureItemNode = (item: { uri: string; kind: SymbolKind; name: string; range: Range; selectionRange: Range }): string | null => {
        const scope = scopeOf(item.uri);
        if (scope === "external" && !options.includeExternal) return null;
        const file = relativePath(root, fileURLToPath(item.uri));
        const start = item.selectionRange.start;
        const id = `${file}:${start.line + 1}:${start.character + 1}`;
        if (!nodes.has(id)) {
          if (atNodeCap()) { truncated = true; return null; }
          const node: GraphNode = {
            id, kind: symbolKindName(item.kind), label: item.name,
            location: { file, line: start.line + 1, column: start.character + 1, endLine: item.range.end.line + 1 },
            scope,
          };
          if (scope !== "local") node.external = true;
          nodes.set(id, node);
        }
        return id;
      };

      // ── pass 1: containment + node kinds, from documentSymbol ──────────────────────────────────────────────
      const callables: Array<{ uri: string; position: Position; nodeId: string }> = [];
      const types: Array<{ uri: string; position: Position; kind: SymbolKind; nodeId: string }> = [];

      for (const file of discovery.files) {
        if (atNodeCap()) { truncated = true; break; }
        const uri = pathToFileURL(file).toString();
        const relFile = relativePath(root, file);
        const fileId = relFile;
        if (!nodes.has(fileId)) nodes.set(fileId, { id: fileId, kind: "file", label: relFile.split("/").pop() ?? relFile, location: { file: relFile, line: 1 }, scope: "local" });

        let symbols: Array<DocumentSymbol | SymbolInformation> | null = null;
        try { symbols = await client.request<Array<DocumentSymbol | SymbolInformation> | null>(DocumentSymbolRequest.type, { textDocument: { uri } }); } catch (error) {
          log.debug("documentSymbol failed", { file: relFile, err: String(error) });
        }

        const addSymbol = (symbol: DocumentSymbol | SymbolInformation, parentId: string): void => {
          if (atNodeCap()) { truncated = true; return; }
          // DocumentSymbol (hierarchical) carries selectionRange + children; SymbolInformation (flat) only a location.
          const position = "selectionRange" in symbol ? symbol.selectionRange.start : symbol.location.range.start;
          const endLine = ("selectionRange" in symbol ? symbol.range.end.line : symbol.location.range.end.line) + 1;
          const id = `${relFile}:${position.line + 1}:${position.character + 1}`;
          if (!nodes.has(id)) nodes.set(id, {
            id, kind: symbolKindName(symbol.kind), label: symbol.name,
            location: { file: relFile, line: position.line + 1, column: position.character + 1, endLine },
            scope: "local",
          });
          addEdge(parentId, id, "contains");
          if (CALLABLE_KINDS.has(symbol.kind)) callables.push({ uri, position, nodeId: id });
          if (TYPE_KINDS.has(symbol.kind)) types.push({ uri, position, kind: symbol.kind, nodeId: id });
          if ("selectionRange" in symbol) for (const child of symbol.children ?? []) addSymbol(child, id);
        };
        for (const symbol of symbols ?? []) addSymbol(symbol, fileId);
      }

      // ── pass 2: calls, from callHierarchy/outgoingCalls per callable ───────────────────────────────────────
      if (hasCallHierarchy) {
        for (const callable of callables) {
          if (atNodeCap()) { truncated = true; break; }
          let prepared: CallHierarchyItem[] | null = null;
          try { prepared = await client.request<CallHierarchyItem[] | null>(CallHierarchyPrepareRequest.type, { textDocument: { uri: callable.uri }, position: callable.position }); } catch { /* unresolvable position */ }
          const item = prepared?.[0];
          if (!item) continue;
          let outgoing: CallHierarchyOutgoingCall[] | null = null;
          try { outgoing = await client.request<CallHierarchyOutgoingCall[] | null>(CallHierarchyOutgoingCallsRequest.type, { item }); } catch (error) {
            log.debug("outgoing calls failed", { id: callable.nodeId, err: String(error) });
          }
          for (const call of outgoing ?? []) {
            const targetId = ensureItemNode(call.to);
            if (targetId) addEdge(callable.nodeId, targetId, "calls", call.fromRanges?.length);
          }
        }
      }

      // ── pass 3: inheritance, from typeHierarchy/supertypes per class/interface ─────────────────────────────
      if (hasTypeHierarchy && options.inheritance !== false) {
        for (const type of types) {
          if (atNodeCap()) { truncated = true; break; }
          let prepared: TypeHierarchyItem[] | null = null;
          try { prepared = await client.request<TypeHierarchyItem[] | null>(TypeHierarchyPrepareRequest.type, { textDocument: { uri: type.uri }, position: type.position }); } catch { /* unresolvable */ }
          const item = prepared?.[0];
          if (!item) continue;
          let supertypes: TypeHierarchyItem[] | null = null;
          try { supertypes = await client.request<TypeHierarchyItem[] | null>(TypeHierarchySupertypesRequest.type, { item }); } catch (error) {
            log.debug("supertypes failed", { id: type.nodeId, err: String(error) });
          }
          for (const supertype of supertypes ?? []) {
            const targetId = ensureItemNode(supertype);
            if (!targetId) continue;
            // A class reaching an interface "implements" it; everything else (class→class, interface→interface) "extends".
            const kind = type.kind === SymbolKind.Class && supertype.kind === SymbolKind.Interface ? "implements" : "extends";
            addEdge(type.nodeId, targetId, kind);
          }
        }
      } else if (!hasTypeHierarchy && options.inheritance !== false && types.length) {
        // The bundled typescript-language-server doesn't advertise a typeHierarchyProvider, so extends/implements
        // can't be derived here. Record it as a note (→ a warn diagnostic) rather than silently omitting it.
        notes.push(`inheritance edges (extends/implements) unavailable — the '${this.name}' server has no type-hierarchy support; containment + calls are still mapped`);
        log.debug("server has no typeHierarchyProvider — skipping inheritance edges");
      }

      const nodeList = [...nodes.values()];
      const edgeKinds: Record<string, number> = {};
      for (const edge of edges) edgeKinds[edge.kind] = (edgeKinds[edge.kind] ?? 0) + 1;
      const graph: CodeGraph = {
        provider: this.name,
        root,
        mode: "repo",
        entry: "",
        nodes: nodeList,
        edges,
        stats: {
          nodes: nodeList.length, edges: edges.length, maxDepth: 0, truncated,
          external: nodeList.filter((node) => node.external).length,
          files: discovery.files.length, edgeKinds,
        },
        ...(notes.length ? { notes } : {}),
      };
      log.info("repo map built", { files: discovery.files.length, nodes: graph.stats.nodes, edges: graph.stats.edges, edgeKinds, truncated });
      return graph;
    } finally {
      await client.dispose();
    }
  }

  /** Resolve an entry to an LSP position: an explicit line:column is used directly; otherwise via `documentSymbol`. */
  async #resolvePosition(client: LspClient, fileUri: string, entry: EntryReference): Promise<Position | undefined> {
    if (entry.line != null && entry.column != null) return { line: entry.line - 1, character: entry.column - 1 };
    const symbols = (await client.request<Array<DocumentSymbol | SymbolInformation> | null>(DocumentSymbolRequest.type, { textDocument: { uri: fileUri } })) ?? [];
    if (entry.symbol) {
      for (const symbol of walkSymbols(symbols)) if (symbol.name === entry.symbol) return symbol.pos;
      return undefined;
    }
    if (entry.line != null) {
      for (const symbol of walkSymbols(symbols)) if (symbol.pos.line === entry.line - 1) return symbol.pos;
      return { line: entry.line - 1, character: 0 }; // fall back to the line start
    }
    return undefined;
  }
}

/** Walk hierarchical DocumentSymbols (or flat SymbolInformation) yielding each symbol's name + name position. */
function* walkSymbols(symbols: Array<DocumentSymbol | SymbolInformation>): Generator<{ name: string; pos: Position }> {
  for (const symbol of symbols) {
    if ("selectionRange" in symbol) {
      yield { name: symbol.name, pos: symbol.selectionRange.start };
      if (symbol.children?.length) yield* walkSymbols(symbol.children);
    } else {
      yield { name: symbol.name, pos: symbol.location.range.start };
    }
  }
}

function relativePath(root: string, file: string): string {
  const relativized = relative(root, file);
  return (relativized.startsWith("..") || isAbsolute(relativized) ? file : relativized).replace(/\\/g, "/");
}

function languageIdFor(uri: string): string {
  switch (extname(fileURLToPath(uri)).toLowerCase()) {
    case ".tsx": return "typescriptreact";
    case ".jsx": return "javascriptreact";
    case ".js": case ".mjs": case ".cjs": return "javascript";
    default: return "typescript";
  }
}

const KIND_NAMES: Partial<Record<SymbolKind, string>> = {
  [SymbolKind.File]: "file",
  [SymbolKind.Module]: "module",
  [SymbolKind.Namespace]: "namespace",
  [SymbolKind.Package]: "package",
  [SymbolKind.Function]: "function",
  [SymbolKind.Method]: "method",
  [SymbolKind.Constructor]: "constructor",
  [SymbolKind.Class]: "class",
  [SymbolKind.Interface]: "interface",
  [SymbolKind.Struct]: "struct",
  [SymbolKind.Enum]: "enum",
  [SymbolKind.EnumMember]: "enum-member",
  [SymbolKind.Property]: "property",
  [SymbolKind.Field]: "field",
  [SymbolKind.Constant]: "constant",
  [SymbolKind.Variable]: "variable",
  [SymbolKind.TypeParameter]: "type-parameter",
};
function symbolKindName(kind: SymbolKind): string {
  return KIND_NAMES[kind] ?? "symbol";
}

/** Symbols that can issue calls — the call-hierarchy pass prepares one of these per node. */
const CALLABLE_KINDS = new Set<SymbolKind>([SymbolKind.Function, SymbolKind.Method, SymbolKind.Constructor]);
/** Symbols that can participate in a type hierarchy (extends/implements) — the inheritance pass walks these. */
const TYPE_KINDS = new Set<SymbolKind>([SymbolKind.Class, SymbolKind.Interface, SymbolKind.Struct]);
