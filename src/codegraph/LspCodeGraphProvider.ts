import { readFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DidOpenTextDocumentNotification,
  DocumentSymbolRequest,
  CallHierarchyPrepareRequest,
  CallHierarchyOutgoingCallsRequest,
  SymbolKind,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type DocumentSymbol,
  type Position,
  type SymbolInformation,
} from "vscode-languageserver-protocol";

import type { CallGraphOptions, CodeGraph, CodeGraphProvider, EntryRef, GraphEdge, GraphNode, NodeScope, ProviderAvailability } from "./CodeGraphProvider.js";
import { LspClient, resolveServer, defaultTsServer } from "./LspClient.js";
import { logger } from "../shared/logger.js";

const log = logger.child({ component: "codegraph", provider: "lsp" });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }

  async callGraph(entry: EntryRef, opts: CallGraphOptions): Promise<CodeGraph> {
    const root = resolve(opts.root);
    const rootUri = pathToFileURL(root + "/").toString();
    const rootPath = fileURLToPath(rootUri).replace(/\\/g, "/");
    const absFile = isAbsolute(entry.file) ? entry.file : resolve(root, entry.file);
    const fileUri = pathToFileURL(absFile).toString();

    const client = new LspClient(resolveServer(opts.server, absFile));
    try {
      const init = await client.initialize({
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
      if (!init.capabilities.callHierarchyProvider) {
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
        const at = entry.symbol ? `symbol "${entry.symbol}"` : `a function on line ${entry.line}`;
        throw new Error(`could not find ${at} in ${rel(root, absFile)}`);
      }

      // tsserver may still be loading the project on the first request; retry prepare a few times.
      let rootItem: CallHierarchyItem | undefined;
      for (let attempt = 0; attempt < 4 && !rootItem; attempt++) {
        if (attempt) await sleep(300);
        const prepared = await client.request<CallHierarchyItem[] | null>(CallHierarchyPrepareRequest.type, { textDocument: { uri: fileUri }, position });
        rootItem = prepared?.[0];
      }
      if (!rootItem) throw new Error(`no callable resolved at ${rel(root, absFile)} — point --entry at a function/method`);

      const scopeOf = (uri: string): NodeScope => {
        const f = fileURLToPath(uri).replace(/\\/g, "/");
        return f.startsWith(rootPath) && !f.includes("/node_modules/") ? "local" : "external";
      };
      const toNode = (it: CallHierarchyItem): GraphNode => {
        const file = rel(root, fileURLToPath(it.uri));
        const start = it.selectionRange.start;
        const scope = scopeOf(it.uri);
        const node: GraphNode = {
          id: `${file}:${start.line + 1}:${start.character + 1}`,
          kind: symbolKindName(it.kind),
          label: it.name,
          loc: { file, line: start.line + 1, col: start.character + 1, endLine: it.range.end.line + 1 },
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

      const register = (it: CallHierarchyItem): GraphNode => {
        const node = toNode(it);
        if (!nodes.has(node.id)) { nodes.set(node.id, node); itemOf.set(node.id, it); }
        return nodes.get(node.id)!;
      };

      const rootNode = register(rootItem);
      const queue: Array<{ id: string; depth: number }> = [{ id: rootNode.id, depth: 0 }];
      while (queue.length) {
        const { id, depth } = queue.shift()!;
        if (expanded.has(id)) continue;
        expanded.add(id);
        const node = nodes.get(id)!;
        if (node.scope === "external" && !opts.includeExternal) continue; // leaf: don't expand into deps
        if (depth >= opts.maxDepth) { truncated = true; continue; }
        if (nodes.size >= opts.maxNodes) { truncated = true; continue; }

        const item = itemOf.get(id)!;
        open(item.uri);
        let outgoing: CallHierarchyOutgoingCall[] | null = null;
        try { outgoing = await client.request<CallHierarchyOutgoingCall[] | null>(CallHierarchyOutgoingCallsRequest.type, { item }); } catch (e) {
          log.debug("outgoing calls failed", { id, err: String(e) });
        }
        for (const oc of outgoing ?? []) {
          const child = register(oc.to);
          const ek = `${id}->${child.id}`;
          if (!edgeKeys.has(ek)) { edgeKeys.add(ek); edges.push({ from: id, to: child.id, kind: "calls", weight: oc.fromRanges?.length }); }
          if ((child.scope === "local" || opts.includeExternal) && !expanded.has(child.id)) queue.push({ id: child.id, depth: depth + 1 });
        }
      }

      const nodeList = [...nodes.values()];
      const graph: CodeGraph = {
        provider: this.name,
        root,
        entry: rootNode.id,
        nodes: nodeList,
        edges,
        stats: { nodes: nodeList.length, edges: edges.length, maxDepth: opts.maxDepth, truncated, external: nodeList.filter((n) => n.external).length },
      };
      log.info("call graph built", { entry: graph.entry, nodes: graph.stats.nodes, edges: graph.stats.edges, truncated });
      return graph;
    } finally {
      await client.dispose();
    }
  }

  /** Resolve an entry to an LSP position: an explicit line:col is used directly; otherwise via `documentSymbol`. */
  async #resolvePosition(client: LspClient, fileUri: string, entry: EntryRef): Promise<Position | undefined> {
    if (entry.line != null && entry.col != null) return { line: entry.line - 1, character: entry.col - 1 };
    const syms = (await client.request<Array<DocumentSymbol | SymbolInformation> | null>(DocumentSymbolRequest.type, { textDocument: { uri: fileUri } })) ?? [];
    if (entry.symbol) {
      for (const s of walkSymbols(syms)) if (s.name === entry.symbol) return s.pos;
      return undefined;
    }
    if (entry.line != null) {
      for (const s of walkSymbols(syms)) if (s.pos.line === entry.line - 1) return s.pos;
      return { line: entry.line - 1, character: 0 }; // fall back to the line start
    }
    return undefined;
  }
}

/** Walk hierarchical DocumentSymbols (or flat SymbolInformation) yielding each symbol's name + name position. */
function* walkSymbols(syms: Array<DocumentSymbol | SymbolInformation>): Generator<{ name: string; pos: Position }> {
  for (const s of syms) {
    if ("selectionRange" in s) {
      yield { name: s.name, pos: s.selectionRange.start };
      if (s.children?.length) yield* walkSymbols(s.children);
    } else {
      yield { name: s.name, pos: s.location.range.start };
    }
  }
}

function rel(root: string, file: string): string {
  const r = relative(root, file);
  return (r.startsWith("..") || isAbsolute(r) ? file : r).replace(/\\/g, "/");
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
  [SymbolKind.Function]: "function",
  [SymbolKind.Method]: "method",
  [SymbolKind.Constructor]: "constructor",
  [SymbolKind.Class]: "class",
  [SymbolKind.Interface]: "interface",
  [SymbolKind.Property]: "property",
  [SymbolKind.Field]: "field",
  [SymbolKind.Variable]: "variable",
};
function symbolKindName(kind: SymbolKind): string {
  return KIND_NAMES[kind] ?? "symbol";
}
