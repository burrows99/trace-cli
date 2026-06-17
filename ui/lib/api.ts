import type { SessionSummary, TraceEnvelope } from "./types";

/**
 * API base. Empty in production (the static export is served by the collector, so /api/* is
 * same-origin). In dev, `.env.development` points it at the collector's own port. `NEXT_PUBLIC_*`
 * is inlined at build time.
 */
export const API_BASE = process.env.NEXT_PUBLIC_TRACE_API ?? "";

export const listSessions = (): Promise<SessionSummary[]> =>
  fetch(`${API_BASE}/api/sessions`).then((r) => r.json());

export const getSession = (id: string): Promise<TraceEnvelope> =>
  fetch(`${API_BASE}/api/sessions/${encodeURIComponent(id)}`).then((r) => r.json());

export const clearSessions = (): Promise<unknown> =>
  fetch(`${API_BASE}/api/sessions`, { method: "DELETE" }).then((r) => r.json());

export const streamUrl = (): string => `${API_BASE}/api/stream`;
