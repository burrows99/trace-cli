import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type SessionStore, type SessionSummary, type EnvelopePlain, summarize } from "./SessionStore.js";

/**
 * FileSessionStore — a SessionStore backed by one JSON file per session under <dataDir>/sessions/, with an
 * in-memory index for the list + realtime fan-out. "SQLite is fine initially" — the file-backed equivalent.
 */
export class FileSessionStore implements SessionStore {
  #dir: string;
  #subscribers = new Set<(s: SessionSummary) => void>();
  #index = new Map<string, SessionSummary>();

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "sessions");
    mkdirSync(this.#dir, { recursive: true });
    for (const f of readdirSync(this.#dir).filter((f) => f.endsWith(".json"))) {
      try {
        const env = JSON.parse(readFileSync(join(this.#dir, f), "utf8"));
        const s = summarize(env);
        if (s.sessionId) this.#index.set(s.sessionId, s);
      } catch { /* skip corrupt */ }
    }
  }

  #fileFor(id: string): string { return join(this.#dir, encodeURIComponent(id) + ".json"); }

  ingest(env: EnvelopePlain): SessionSummary | null {
    const s = summarize(env);
    if (!s.sessionId) return null;
    writeFileSync(this.#fileFor(s.sessionId), JSON.stringify(env));
    this.#index.set(s.sessionId, s);
    for (const fn of this.#subscribers) { try { fn(s); } catch { /* dead subscriber */ } }
    return s;
  }

  list(): SessionSummary[] {
    return [...this.#index.values()].sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  }

  get(id: string): EnvelopePlain | null {
    const p = this.#fileFor(id);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }

  subscribe(fn: (s: SessionSummary) => void): () => void { this.#subscribers.add(fn); return () => this.#subscribers.delete(fn); }

  clear(): void {
    for (const id of this.#index.keys()) { try { rmSync(this.#fileFor(id)); } catch { /* ignore */ } }
    this.#index.clear();
  }

  size(): number { return this.#index.size; }
}
