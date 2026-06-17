/** A compact session row for the list view + realtime stream. */
export interface SessionSummary {
  sessionId: string | null;
  command: string | null;
  target: string | null;
  source: string | null;
  ok: boolean | null;
  at: string | null;
  durationMs: number | null;
  eventCount: number;
  trigger: string | null;
  errors: number;
  warns: number;
}

export type EnvelopePlain = Record<string, any>;

/**
 * SessionStore — abstraction for persisting + serving traces (DIP). The Collector depends on this interface,
 * so the file-backed store can be swapped for SQLite/ClickHouse at scale with no Collector change.
 */
export interface SessionStore {
  ingest(env: EnvelopePlain): SessionSummary | null;
  list(): SessionSummary[];
  get(id: string): EnvelopePlain | null;
  subscribe(fn: (s: SessionSummary) => void): () => void;
  clear(): void;
  size(): number;
}

/** summarize(env) — the compact row for an ingested envelope. */
export function summarize(env: EnvelopePlain): SessionSummary {
  const events = env?.data?.events ?? [];
  const diags: Array<{ level: string }> = env?.diagnostics ?? [];
  return {
    sessionId: env?.meta?.sessionId ?? null,
    command: env?.command ?? null,
    target: env?.target?.kind ?? null,
    source: env?.target?.source ?? events[0]?.source ?? null,
    ok: env?.ok ?? null,
    at: env?.meta?.at ?? null,
    durationMs: env?.meta?.durationMs ?? null,
    eventCount: events.length,
    trigger: env?.target?.trigger ?? null,
    errors: diags.filter((d) => d.level === "error").length,
    warns: diags.filter((d) => d.level === "warn").length,
  };
}
