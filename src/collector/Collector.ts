import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSessionStore } from "./createSessionStore.js";
import type { SessionStore } from "./SessionStore.js";

const here = dirname(fileURLToPath(import.meta.url));
const UI_PATH = join(here, "ui.html");

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

  /** POST an envelope to a remote collector's /v1/traces (used by `trace dynamic --emit`). */
  static async emit(url: string, envelope: unknown): Promise<boolean> {
    const endpoint = url.replace(/\/+$/, "") + "/v1/traces";
    try {
      const r = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
      process.stderr.write(`[trace] emitted → ${endpoint} (${r.status})\n`);
      return r.ok;
    } catch (e: any) {
      process.stderr.write(`[trace] emit failed (${endpoint}): ${e.message}\n`);
      return false;
    }
  }

  listen(opts: { port?: number; host?: string } = {}): Server {
    const { port = 4000, host = "0.0.0.0" } = opts;
    const store = this.#store;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const json = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(obj)); };

      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type" }); return res.end(); }

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(readFileSync(UI_PATH, "utf8"));
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") return void store.list().then((l) => json(200, l)).catch((e) => json(500, { error: e.message }));
      if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
        return void store.get(id).then((env) => env ? json(200, env) : json(404, { error: "not found" })).catch((e) => json(500, { error: e.message }));
      }
      if (req.method === "DELETE" && url.pathname === "/api/sessions") return void store.clear().then(() => json(200, { ok: true })).catch((e) => json(500, { error: e.message }));

      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        const unsub = store.subscribe((s) => res.write(`data: ${JSON.stringify(s)}\n\n`));
        store.size().then((count) => res.write(`event: hello\ndata: ${JSON.stringify({ count })}\n\n`)).catch(() => res.write(`event: hello\ndata: ${JSON.stringify({ count: null })}\n\n`));
        const keepalive = setInterval(() => res.write(": keepalive\n\n"), 25000);
        req.on("close", () => { clearInterval(keepalive); unsub(); });
        return;
      }

      if (req.method === "POST" && (url.pathname === "/v1/traces" || url.pathname === "/api/ingest")) {
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 64 * 1024 * 1024) req.destroy(); });
        req.on("end", async () => {
          try {
            const s = await store.ingest(JSON.parse(body));
            if (!s) return json(400, { error: "envelope has no meta.sessionId" });
            json(200, { ok: true, sessionId: s.sessionId });
          } catch (e: any) { json(400, { error: e.message }); }
        });
        return;
      }

      json(404, { error: "not found" });
    });

    server.listen(port, host, () => {
      store.size()
        .then((n) => process.stderr.write(`[trace] collector + UI → http://localhost:${port}  (data via ${this.#store.constructor.name}, ${n} sessions)\n`))
        .catch((e) => process.stderr.write(`[trace] collector + UI → http://localhost:${port}  (data via ${this.#store.constructor.name}; store unavailable: ${e.message})\n`));
    });
    return server;
  }
}
