import "reflect-metadata"; // decorator metadata for Trace's class-validator/-transformer must init first

/**
 * `trace-cli/server` — the narrow server-side surface the hosted dashboard (ui/) consumes.
 *
 * The Next.js standalone server reuses the CLI's persistence + envelope contract instead of
 * re-implementing them: `createSessionStore()` (owns the `trace_sessions` DDL, `summarize()` and
 * in-process realtime `subscribe`) and `Trace` (the single (de)serialization + validation contract).
 *
 * Deliberately excludes the rest of the CLI (CDP/LSP/commander/recorder) so Next's output-file tracing
 * only pulls in the store + domain + `pg` + class-validator/transformer — not the whole toolchain.
 */
export { createSessionStore } from "./collector/createSessionStore.js";
export type { StoreOptions } from "./collector/createSessionStore.js";
export { summarize } from "./collector/SessionStore.js";
export type { SessionStore, SessionSummary, EnvelopePlain } from "./collector/SessionStore.js";
export { Trace } from "./domain/Trace.js";
