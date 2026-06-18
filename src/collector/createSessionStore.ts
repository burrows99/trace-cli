import { type SessionStore } from "./SessionStore.js";
import { PostgresSessionStore } from "./PostgresSessionStore.js";

export interface StoreOptions {
  /** Postgres connection string; overrides DATABASE_URL/POSTGRES_URL when given. */
  databaseUrl?: string;
}

/**
 * createSessionStore — build the Postgres-backed SessionStore from configuration. The connection string comes
 * from explicit `databaseUrl` or env `DATABASE_URL`/`POSTGRES_URL`. There is no file fallback: the collector
 * is database-driven, so a missing connection string is a hard, fail-fast error rather than silent local state.
 */
export function createSessionStore(options: StoreOptions = {}): SessionStore {
  const url = options.databaseUrl ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "no Postgres connection string — set DATABASE_URL (or POSTGRES_URL), or pass --database-url.\n" +
      "  e.g. DATABASE_URL=postgres://user:pass@localhost:5432/trace",
    );
  }
  return new PostgresSessionStore(url);
}
