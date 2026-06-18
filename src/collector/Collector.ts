import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createSessionStore } from "./createSessionStore.js";
import type { SessionStore } from "./SessionStore.js";
import { Trace } from "../domain/Trace.js";
import { DEFAULT_COLLECTOR_PORT } from "../shared/defaults.js";
import { logger } from "../shared/logger.js";

const log = logger.child({ component: "collector" });

const here = dirname(fileURLToPath(import.meta.url));
// The Next.js static export (ui/out) is copied here by the build (see package.json `build`).
const UI_DIR = join(here, "ui");

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
function serveStatic(res: ServerResponse, dir: string, pathname: string): boolean {
  const rel = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const root = resolve(dir);
  let target = resolve(root, "." + rel);
  if (target !== root && !target.startsWith(root + sep)) return false; // traversal
  if (!existsSync(target) || !statSync(target).isFile()) {
    if (extname(rel)) return false; // a real asset is missing → 404
    target = join(root, "index.html"); // extension-less route → SPA fallback
    if (!existsSync(target)) return false;
  }
  const ext = extname(target);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  res.end(readFileSync(target));
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
      const r = await fetch(endpoint, { method: "POST", headers: { "content-type": CT_JSON }, body: JSON.stringify(envelope) });
      log.info("emitted envelope", { endpoint, status: r.status });
      return r.ok;
    } catch (e: any) {
      log.error("emit failed", { endpoint, err: e });
      return false;
    }
  }

  listen(opts: { port?: number; host?: string } = {}): Server {
    const { port = DEFAULT_COLLECTOR_PORT, host = "0.0.0.0" } = opts;
    const store = this.#store;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const startedAt = Date.now();
      const url = new URL(req.url ?? "/", "http://localhost");
      res.on("finish", () => log.debug("request", { method: req.method, path: url.pathname, status: res.statusCode, durationMs: Date.now() - startedAt }));
      const json = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": CT_JSON, ...CORS_ORIGIN }); res.end(JSON.stringify(obj)); };

      if (req.method === "OPTIONS") { res.writeHead(204, CORS_PREFLIGHT); return res.end(); }

      if (req.method === "GET" && url.pathname === "/api/sessions") return void store.list().then((l) => json(200, l)).catch((e) => json(500, { error: e.message }));
      if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
        return void store.get(id).then((env) => env ? json(200, env) : json(404, { error: "not found" })).catch((e) => json(500, { error: e.message }));
      }
      if (req.method === "DELETE" && url.pathname === "/api/sessions") return void store.clear().then(() => json(200, { ok: true })).catch((e) => json(500, { error: e.message }));

      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...CORS_ORIGIN });
        const unsub = store.subscribe((s) => res.write(`data: ${JSON.stringify(s)}\n\n`));
        store.size().then((count) => res.write(`event: hello\ndata: ${JSON.stringify({ count })}\n\n`)).catch(() => res.write(`event: hello\ndata: ${JSON.stringify({ count: null })}\n\n`));
        const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25000);
        req.on("close", () => { clearInterval(keepalive); unsub(); });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/traces") {
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 64 * 1024 * 1024) { log.warn("ingest body too large — connection destroyed", { bytes: body.length }); req.destroy(); } });
        req.on("end", async () => {
          try {
            // Ingress boundary: hydrate untrusted JSON into a Trace and enforce the envelope contract before
            // it touches the store. Reject malformed envelopes with their violations instead of persisting them.
            const env = Trace.fromPlain(JSON.parse(body));
            const problems = env.validate();
            if (problems.length) { log.warn("rejected invalid envelope", { bytes: body.length, problems }); return json(400, { error: "invalid envelope", problems }); }
            const s = await store.ingest(env.toJSON());
            if (!s) { log.warn("rejected envelope without meta.sessionId", { bytes: body.length }); return json(400, { error: "envelope has no meta.sessionId" }); }
            log.info("ingested envelope", { sessionId: s.sessionId, command: s.command, events: s.eventCount, errors: s.errors, warns: s.warns });
            json(200, { ok: true, sessionId: s.sessionId });
          } catch (e: any) { log.warn("ingest failed", { err: e }); json(400, { error: e.message }); }
        });
        return;
      }

      // Everything else: serve the static Next.js UI (index.html + /_next/* assets).
      if (req.method === "GET" || req.method === "HEAD") {
        if (!existsSync(UI_DIR)) {
          res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
          return res.end("trace UI not built. Run `npm run build` (builds ui/ → dist/collector/ui).\n");
        }
        if (serveStatic(res, UI_DIR, url.pathname)) return;
      }

      json(404, { error: "not found" });
    });

    server.listen(port, host, () => {
      store.size()
        .then((n) => log.info("collector + UI listening", { url: `http://localhost:${port}`, store: this.#store.constructor.name, sessions: n }))
        .catch((e) => log.warn("collector + UI listening; store unavailable", { url: `http://localhost:${port}`, store: this.#store.constructor.name, err: e }));
    });
    return server;
  }
}
