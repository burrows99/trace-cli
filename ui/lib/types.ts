/**
 * Wire types for the trace envelope + session summary. These mirror the CLI's domain
 * (src/domain/*) and collector contract (src/collector/SessionStore.ts) as plain JSON —
 * the shape that crosses /api/sessions, /api/sessions/:id and the SSE stream.
 */

/** Compact row for the list view + realtime stream (matches SessionStore.SessionSummary). */
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
  running?: boolean;
}

export interface Loc {
  file: string;
  line?: number;
}

export interface TraceEventAttrs {
  locals?: Record<string, unknown>;
  exprs?: Record<string, unknown>;
  stack?: string[];
}

export interface TraceEvent {
  seq: number;
  t?: number | string;
  kind: string;
  label?: string;
  source?: string;
  loc?: Loc;
  attrs?: TraceEventAttrs;
}

export interface LineagePoint {
  seq: number;
  value: unknown;
  changed?: boolean;
}

export interface Lineage {
  name: string;
  kind: "expr" | "local";
  occurrences: number;
  changes: number;
  series: LineagePoint[];
}

export interface Recording {
  url?: string;
  path?: string;
  bytes?: number;
}

export interface CurlResponse {
  exitCode?: number;
  body?: string;
  stderr?: string;
  error?: string;
}

export interface ConsoleLine {
  type: string;
  text: string;
}

export interface NetworkLine {
  status: number;
  url: string;
}

export interface TraceData {
  events?: TraceEvent[];
  lineage?: Lineage[];
  recording?: Recording;
  response?: CurlResponse;
  console?: ConsoleLine[];
  network?: NetworkLine[];
}

export interface TargetRef {
  kind?: string;
  source?: string;
  trigger?: string;
}

export interface TraceMeta {
  at?: string;
  sessionId?: string;
  durationMs?: number;
  running?: boolean;
}

export interface Diagnostic {
  level: string;
  message: string;
}

/** The full envelope returned by GET /api/sessions/:id (matches domain/Trace.toJSON()). */
export interface TraceEnvelope {
  tool?: string;
  version?: string;
  command?: string;
  ok?: boolean;
  meta?: TraceMeta;
  target?: TargetRef | null;
  data?: TraceData;
  diagnostics?: Diagnostic[];
}
