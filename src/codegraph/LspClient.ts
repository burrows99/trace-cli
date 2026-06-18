import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import { InitializeRequest, InitializedNotification, ShutdownRequest, ExitNotification, type InitializeParams, type InitializeResult } from "vscode-languageserver-protocol";

import { logger } from "../shared/logger.js";

const log = logger.child({ component: "lsp" });

/** How to launch a language server: a command + args that speak LSP over stdio. */
export interface LspServerSpec {
  command: string;
  args: string[];
}

/**
 * Resolve the bundled TypeScript language server (`typescript-language-server`, a dependency) to a launch spec.
 * Run via the current Node so it works whether trace-cli is installed locally or globally — no PATH assumption.
 */
export function defaultTsServer(): LspServerSpec {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("typescript-language-server/package.json");
  const bin = (require("typescript-language-server/package.json").bin as Record<string, string>)["typescript-language-server"];
  return { command: process.execPath, args: [join(dirname(pkgPath), bin), "--stdio"] };
}

/** TypeScript/JavaScript extensions handled by the bundled server. */
const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
/** Default LSP server command per file extension (the server binary must be on PATH). */
const SERVER_BY_EXT: Record<string, string> = {
  ".go": "gopls",
  ".py": "pyright-langserver --stdio",
  ".rs": "rust-analyzer",
  ".rb": "solargraph stdio",
  ".c": "clangd", ".h": "clangd", ".cc": "clangd", ".cpp": "clangd", ".hpp": "clangd",
};

/** Pick the default LSP server for a file by its extension (bundled TS server for TS/JS). */
export function serverForFile(file: string): LspServerSpec {
  const ext = extname(file).toLowerCase();
  if (TS_EXT.has(ext)) return defaultTsServer();
  const cmd = SERVER_BY_EXT[ext];
  if (!cmd) throw new Error(`no default LSP server for "${ext}" files — pass --server "<command>"`);
  const [command, ...args] = cmd.split(/\s+/);
  return { command, args };
}

/**
 * Resolve the server to launch: an explicit `--server`/env override wins; otherwise auto-pick by the entry
 * file's extension. So the common case needs no server flag at all.
 */
export function resolveServer(server: string | undefined, file?: string): LspServerSpec {
  const s = (server ?? process.env.TRACE_LSP_SERVER)?.trim();
  if (s) { const [command, ...args] = s.split(/\s+/); return { command, args }; }
  if (file) return serverForFile(file);
  return defaultTsServer();
}

/**
 * LspClient — a thin lifecycle wrapper over Microsoft's official `vscode-jsonrpc` transport. It spawns a
 * language server and exposes typed request/notify plus the initialize/shutdown handshake. All protocol
 * semantics (call hierarchy, document symbols, project loading) live in the server, not here — this is just
 * the JSON-RPC pipe IDEs use, so the tool is a standard LSP client rather than a bespoke analyzer.
 */
export class LspClient {
  readonly #child: ChildProcess;
  readonly #conn: MessageConnection;

  constructor(spec: LspServerSpec) {
    this.#child = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.#child.on("error", (e) => log.error("server spawn failed", { command: spec.command, err: String(e) }));
    this.#child.stderr?.on("data", (d) => log.debug("server stderr", { msg: String(d).trim().slice(0, 300) }));
    // Swallow stray pipe errors (EPIPE / write-after-destroy during teardown) so they never surface as
    // unhandled events — the connection lifecycle, not the raw socket, is the source of truth.
    this.#child.stdin?.on("error", () => {});
    this.#child.stdout?.on("error", () => {});
    this.#conn = createMessageConnection(new StreamMessageReader(this.#child.stdout!), new StreamMessageWriter(this.#child.stdin!));
    this.#conn.onError(([e]) => log.debug("connection error", { err: String(e) }));
    this.#conn.listen();
  }

  /** Send an LSP request (loosely typed: call sites pass the protocol's typed request constants). */
  request<R>(type: any, params?: any): Promise<R> {
    return this.#conn.sendRequest(type, params);
  }

  /** Send an LSP notification. */
  notify(type: any, params?: any): void {
    void this.#conn.sendNotification(type, params);
  }

  /** The LSP handshake: `initialize` request → `initialized` notification. Returns the server's capabilities. */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    const result = await this.#conn.sendRequest(InitializeRequest.type, params);
    this.#conn.sendNotification(InitializedNotification.type as any, {});
    return result;
  }

  /** Graceful teardown: `shutdown` → `exit` (awaiting the flush so no write is in-flight), then drop the pipe. */
  async dispose(): Promise<void> {
    try {
      await this.#conn.sendRequest(ShutdownRequest.type);
      await this.#conn.sendNotification(ExitNotification.type as any); // await the flush before destroying streams
    } catch { /* server already gone */ }
    try { this.#conn.dispose(); } catch { /* noop */ }
    try { this.#child.kill(); } catch { /* noop */ }
  }
}
