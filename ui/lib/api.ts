import type { SessionSummary, TraceEnvelope } from "./types";

/**
 * Same-origin API. The standalone Next server hosts both the UI and the Route Handlers under `/api/*`,
 * so every call is relative — no base URL, no CORS. (Previously the static export was served by a separate
 * collector port, which needed `NEXT_PUBLIC_TRACE_API`.)
 */
export const listSessions = (): Promise<SessionSummary[]> =>
  fetch(`/api/sessions`).then((r) => r.json());

export const getSession = (id: string): Promise<TraceEnvelope> =>
  fetch(`/api/sessions/${encodeURIComponent(id)}`).then((r) => r.json());

export const clearSessions = (): Promise<unknown> =>
  fetch(`/api/sessions`, { method: "DELETE" }).then((r) => r.json());

export const streamUrl = (): string => `/api/stream`;
