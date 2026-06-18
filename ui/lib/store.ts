import { createSessionStore, type SessionStore } from "trace-cli/server";

/**
 * Lazy, process-wide SessionStore singleton for the Route Handlers.
 *
 * - **Lazy** (built on first request, not at module load) so `next build` — which imports route modules to
 *   collect routes — never needs `DATABASE_URL`. `createSessionStore()` throws without it.
 * - **Memoized on `globalThis`** so Next's dev HMR (which re-evaluates modules) reuses one Postgres pool +
 *   one set of SSE subscribers instead of leaking a pool per reload.
 *
 * Single-instance only: realtime fan-out rides the store's in-process `subscribe`. A multi-instance
 * deployment would layer Postgres LISTEN/NOTIFY on top (see plan: deferred).
 */
const globalForStore = globalThis as unknown as { __traceStore?: SessionStore };

export function getStore(): SessionStore {
  return (globalForStore.__traceStore ??= createSessionStore());
}
