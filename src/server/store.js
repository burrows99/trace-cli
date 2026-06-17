// File-backed session store for the collector. One envelope per session, keyed by meta.sessionId, written
// as JSON under <dataDir>/sessions/. An in-memory index keeps the list view + realtime fan-out cheap.
// "SQLite is fine initially" — this is the file-backed equivalent; swap for SQLite/ClickHouse behind this
// same interface when scale demands (see docs/MIGRATION.md §8).

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// summarize(env) → the compact session row used by the list view and the realtime stream.
export function summarize(env) {
  const events = env?.data?.events || [];
  const diags = env?.diagnostics || [];
  return {
    sessionId: env?.meta?.sessionId || null,
    command: env?.command || null,
    target: env?.target?.kind || null,
    source: env?.target?.source || events[0]?.source || null,
    ok: env?.ok ?? null,
    at: env?.meta?.at || null,
    durationMs: env?.meta?.durationMs ?? null,
    eventCount: events.length,
    trigger: env?.target?.trigger || null,
    errors: diags.filter((d) => d.level === "error").length,
    warns: diags.filter((d) => d.level === "warn").length,
  };
}

// createStore(dataDir) → { ingest, list, get, subscribe, clear, size }. Loads any existing sessions on boot.
export function createStore(dataDir) {
  const dir = join(dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  const subscribers = new Set();
  const index = new Map(); // sessionId → summary

  const fileFor = (id) => join(dir, encodeURIComponent(id) + ".json");

  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const env = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const s = summarize(env);
      if (s.sessionId) index.set(s.sessionId, s);
    } catch { /* skip a corrupt file */ }
  }

  return {
    // ingest(env) → summary (or null if the envelope has no sessionId). Persists, indexes, and fans out.
    ingest(env) {
      const s = summarize(env);
      if (!s.sessionId) return null;
      writeFileSync(fileFor(s.sessionId), JSON.stringify(env));
      index.set(s.sessionId, s);
      for (const fn of subscribers) { try { fn(s); } catch { /* a dead subscriber shouldn't break ingest */ } }
      return s;
    },
    list() {
      return [...index.values()].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    },
    get(id) {
      const p = fileFor(id);
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    clear() {
      for (const id of index.keys()) { try { rmSync(fileFor(id)); } catch {} }
      index.clear();
    },
    size: () => index.size,
  };
}
