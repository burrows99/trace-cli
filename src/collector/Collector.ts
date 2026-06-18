import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createSessionStore } from "./createSessionStore.js";
import type { SessionStore } from "./SessionStore.js";
import { Trace } from "../domain/Trace.js";
import { DEFAULT_COLLECTOR_PORT } from "../shared/defaults.js";
import { logger } from "../shared/logger.js";
import { Code } from "../shared/codes.js";

const log = logger.child({ component: "collector" });

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
// The Next.js static export (ui/out) is copied here by the build (see package.json `build`).
const UI_DIR = join(moduleDirectory, "ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const CT_JSON = "application/json";
/** Permissive CORS origin attached to every API/SSE response (the UI may be served from any host). */
const CORS_ORIGIN: Record<string, string> = { "access-control-allow-origin": "*" };
/** Preflight response headers for OPTIONS. */
const CORS_PREFLIGHT: Record<string, string> = {
  ...CORS_ORIGIN,
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * Serve a file from the static export dir. Maps `/` → index.html, guards against path traversal,
 * and falls back to index.html for extension-less paths (SPA routing). Returns false if nothing
 * was served (missing asset / traversal), so the caller can 404.
 */
function serveStatic(response: ServerResponse, directory: string, pathname: string): boolean {
  const relativePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const root = resolve(directory);
  let target = resolve(root, "." + relativePath);
  if (target !== root && !target.startsWith(root + sep)) return false; // traversal
  if (!existsSync(target) || !statSync(target).isFile()) {
    if (extname(relativePath)) return false; // a real asset is missing → 404
    target = join(root, "index.html"); // extension-less route → SPA fallback
    if (!existsSync(target)) return false;
  }
  const extension = extname(target);
  response.writeHead(200, {
    "content-type": MIME[extension] ?? "application/octet-stream",
    "cache-control": extension === ".html" ? "no-cache" : "public, max-age=3600",
  });
  response.end(readFileSync(target));
  return true;
}

/**
 * Collector — the trace collection service: ingests envelopes (POST /v1/traces), persists via a SessionStore
 * (DIP), fans new sessions out over SSE, and serves the realtime UI. Depends on the SessionStore abstraction,
 * not a concrete backend — Postgres, resolved from DATABASE_URL/POSTGRES_URL (see createSessionStore).
 */
export class Collector {
  #store: SessionStore;

  constructor(store?: SessionStore) {
    this.#store = store ?? createSessionStore();
  }

  /** POST an envelope to a remote collector's /v1/traces (used when TRACE_COLLECTOR_URL is set). */
  static async emit(url: string, envelope: unknown): Promise<boolean> {
    const endpoint = url.replace(/\/+$/, "") + "/v1/traces";
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": CT_JSON }, body: JSON.stringify(envelope) });
      log.info("emitted envelope", { endpoint, status: response.status });
      return response.ok;
    } catch (error: any) {
      log.error("emit failed", { code: Code.EMIT, endpoint, err: error });
      return false;
    }
  }

  listen(options: { port?: number; host?: string } = {}): Server {
    const { port = DEFAULT_COLLECTOR_PORT, host = "0.0.0.0" } = options;
    const store = this.#store;

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const startedAt = Date.now();
      const url = new URL(request.url ?? "/", "http://localhost");
      response.on("finish", () => log.debug("request", { method: request.method, path: url.pathname, status: response.statusCode, durationMs: Date.now() - startedAt }));
      const json = (statusCode: number, payload: unknown) => { response.writeHead(statusCode, { "content-type": CT_JSON, ...CORS_ORIGIN }); response.end(JSON.stringify(payload)); };

      if (request.method === "OPTIONS") { response.writeHead(204, CORS_PREFLIGHT); return response.end(); }

      if (request.method === "GET" && url.pathname === "/api/sessions") return void store.list().then((summaries) => json(200, summaries)).catch((error) => json(500, { error: error.message }));
      if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
        return void store.get(id).then((envelope) => envelope ? json(200, envelope) : json(404, { error: "not found" })).catch((error) => json(500, { error: error.message }));
      }
      if (request.method === "DELETE" && url.pathname === "/api/sessions") return void store.clear().then(() => json(200, { ok: true })).catch((error) => json(500, { error: error.message }));

      if (request.method === "GET" && url.pathname === "/api/stream") {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...CORS_ORIGIN });
        const unsubscribe = store.subscribe((summary) => response.write(`data: ${JSON.stringify(summary)}\n\n`));
        store.size().then((count) => response.write(`event: hello\ndata: ${JSON.stringify({ count })}\n\n`)).catch(() => response.write(`event: hello\ndata: ${JSON.stringify({ count: null })}\n\n`));
        const keepalive = setInterval(() => response.write(": keepalive\n\n"), 25000);
        request.on("close", () => { clearInterval(keepalive); unsubscribe(); });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/traces") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; if (body.length > 64 * 1024 * 1024) { log.warn("ingest body too large — connection destroyed", { code: Code.INGEST, bytes: body.length }); request.destroy(); } });
        request.on("end", async () => {
          try {
            // Ingress boundary: hydrate untrusted JSON into a Trace and enforce the envelope contract before
            // it touches the store. Reject malformed envelopes with their violations instead of persisting them.
            const envelope = Trace.fromPlain(JSON.parse(body));
            const problems = envelope.validate();
            if (problems.length) { log.warn("rejected invalid envelope", { code: Code.INGEST_INVALID, bytes: body.length, problems }); return json(400, { error: "invalid envelope", problems }); }
            const summary = await store.ingest(envelope.toJSON());
            if (!summary) { log.warn("rejected envelope without meta.sessionId", { code: Code.INGEST_NO_SESSION, bytes: body.length }); return json(400, { error: "envelope has no meta.sessionId" }); }
            log.info("ingested envelope", { sessionId: summary.sessionId, command: summary.command, events: summary.eventCount, errors: summary.errors, warns: summary.warns });
            json(200, { ok: true, sessionId: summary.sessionId });
          } catch (error: any) { log.warn("ingest failed", { code: Code.INGEST, err: error }); json(400, { error: error.message }); }
        });
        return;
      }

      // Everything else: serve the static Next.js UI (index.html + /_next/* assets).
      if (request.method === "GET" || request.method === "HEAD") {
        if (!existsSync(UI_DIR)) {
          response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
          return response.end("trace UI not built. Run `npm run build` (builds ui/ → dist/collector/ui).\n");
        }
        if (serveStatic(response, UI_DIR, url.pathname)) return;
      }

      json(404, { error: "not found" });
    });

    server.listen(port, host, () => {
      store.size()
        .then((sessionCount) => log.info("collector + UI listening", { url: `http://localhost:${port}`, store: this.#store.constructor.name, sessions: sessionCount }))
        .catch((error) => log.warn("collector + UI listening; store unavailable", { code: Code.STORE, url: `http://localhost:${port}`, store: this.#store.constructor.name, err: error }));
    });
    return server;
  }
}
