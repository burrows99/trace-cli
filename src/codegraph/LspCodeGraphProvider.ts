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

import type { CallGraphOptions, CodeGraph, CodeGraphProvider, EntryReference, GraphEdge, GraphNode, NodeScope, ProviderAvailability } from "./CodeGraphProvider.js";
import { LspClient, resolveServer, defaultTsServer } from "./LspClient.js";
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
