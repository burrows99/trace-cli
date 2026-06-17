import pg from "pg";
import { type SessionStore, type SessionSummary, type EnvelopePlain, summarize } from "./SessionStore.js";

const { Pool } = pg;

/**
 * PostgresSessionStore — the SessionStore, backed by Postgres. Each trace envelope lands in one
 * `trace_sessions` row: the full envelope as JSONB plus its precomputed `summary` (so the list view never
 * deserializes whole envelopes) and a sortable `at`. This is the single persistence backend — the Collector
 * depends only on the SessionStore interface (DIP), so swapping Postgres for another store stays a local change.
 *
 * Schema is created lazily on first use (CREATE TABLE IF NOT EXISTS), so pointing `DATABASE_URL` at an empty
 * database just works. Realtime fan-out is in-process (one collector instance); a multi-instance deployment
 * would layer Postgres LISTEN/NOTIFY on top of `subscribe`.
 */
export class PostgresSessionStore implements SessionStore {
  #pool: pg.Pool;
  #table: string;
  #subscribers = new Set<(s: SessionSummary) => void>();
  #ready: Promise<void> | null = null;

  constructor(connectionString: string, table = "trace_sessions") {
    // The table name is interpolated into DDL/DML (it can't be a bind parameter), so allow only safe identifiers.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) throw new Error(`invalid table name: ${table}`);
    this.#table = table;
    this.#pool = new Pool({ connectionString });
    // Surface pool-level errors instead of crashing the process on an idle-client disconnect.
    this.#pool.on("error", (e) => process.stderr.write(`[trace] pg pool error: ${e.message}\n`));
  }

  /** Create the table + index once; every data method awaits this first. */
  #init(): Promise<void> {
    return (this.#ready ??= this.#pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.#table} (
         session_id  text PRIMARY KEY,
         envelope    jsonb NOT NULL,
         summary     jsonb NOT NULL,
         at          text,
         ingested_at timestamptz NOT NULL DEFAULT now()
       );
       CREATE INDEX IF NOT EXISTS ${this.#table}_at_idx ON ${this.#table} (at DESC NULLS LAST);`,
    ).then(() => undefined));
  }

  async ingest(env: EnvelopePlain): Promise<SessionSummary | null> {
    const s = summarize(env);
    if (!s.sessionId) return null;
    await this.#init();
    await this.#pool.query(
      `INSERT INTO ${this.#table} (session_id, envelope, summary, at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4)
       ON CONFLICT (session_id) DO UPDATE
         SET envelope = EXCLUDED.envelope, summary = EXCLUDED.summary, at = EXCLUDED.at, ingested_at = now()`,
      [s.sessionId, JSON.stringify(env), JSON.stringify(s), s.at],
    );
    for (const fn of this.#subscribers) { try { fn(s); } catch { /* dead subscriber */ } }
    return s;
  }

  async list(): Promise<SessionSummary[]> {
    await this.#init();
    const { rows } = await this.#pool.query(`SELECT summary FROM ${this.#table} ORDER BY at DESC NULLS LAST`);
    return rows.map((r) => r.summary as SessionSummary);
  }

  async get(id: string): Promise<EnvelopePlain | null> {
    await this.#init();
    const { rows } = await this.#pool.query(`SELECT envelope FROM ${this.#table} WHERE session_id = $1`, [id]);
    return rows[0]?.envelope ?? null;
  }

  subscribe(fn: (s: SessionSummary) => void): () => void { this.#subscribers.add(fn); return () => this.#subscribers.delete(fn); }

  async clear(): Promise<void> {
    await this.#init();
    await this.#pool.query(`DELETE FROM ${this.#table}`);
  }

  async size(): Promise<number> {
    await this.#init();
    const { rows } = await this.#pool.query(`SELECT count(*)::int AS n FROM ${this.#table}`);
    return rows[0]?.n ?? 0;
  }

  /** Release pooled connections (for tests / graceful shutdown). */
  async close(): Promise<void> { await this.#pool.end(); }
}
