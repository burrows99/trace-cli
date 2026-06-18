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
  /** true while the run is still in flight (emitted from a partial envelope); absent/false once finished. */
  running: boolean;
}

export type EnvelopePlain = Record<string, any>;

/**
 * SessionStore — abstraction for persisting + serving traces (DIP). The Collector depends on this interface,
 * not a concrete backend, so the store can be swapped (e.g. Postgres → ClickHouse) at scale. The data methods
 * are async so a networked backend is a first-class implementation, not a blocking hack; `subscribe` stays
 * sync because it only registers a realtime callback. The shipped implementation is PostgresSessionStore.
 */
export interface SessionStore {
  ingest(envelope: EnvelopePlain): Promise<SessionSummary | null>;
  list(): Promise<SessionSummary[]>;
  get(id: string): Promise<EnvelopePlain | null>;
  subscribe(callback: (summary: SessionSummary) => void): () => void;
  clear(): Promise<void>;
  size(): Promise<number>;
}

/** summarize(envelope) — the compact row for an ingested envelope. */
export function summarize(envelope: EnvelopePlain): SessionSummary {
  const events = envelope?.data?.events ?? [];
  const diagnostics: Array<{ level: string }> = envelope?.diagnostics ?? [];
  return {
    sessionId: envelope?.meta?.sessionId ?? null,
    command: envelope?.command ?? null,
    target: envelope?.target?.kind ?? null,
    source: envelope?.target?.source ?? events[0]?.source ?? null,
    ok: envelope?.ok ?? null,
    at: envelope?.meta?.at ?? null,
    durationMs: envelope?.meta?.durationMs ?? null,
    eventCount: events.length,
    trigger: envelope?.target?.trigger ?? null,
    errors: diagnostics.filter((diagnostic) => diagnostic.level === "error").length,
    warns: diagnostics.filter((diagnostic) => diagnostic.level === "warn").length,
    running: envelope?.meta?.running === true,
  };
}
