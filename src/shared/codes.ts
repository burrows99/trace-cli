/**
 * Code — the one shared vocabulary of issue codes, drawn from by BOTH channels:
 *   • the response envelope's {@link Diagnostic}s (stdout), and
 *   • the execution logs the {@link Logger} writes (stderr, via a `code` field).
 * When a stderr warning and an envelope diagnostic describe the same event they carry the *same* code, so an
 * agent (or a human grepping) can join "what I saw while it ran" to "what landed in the result". Codes are
 * stable, semantic, and greppable — the parseable counterpart to a free-text message (cf. Anthropic's
 * tool-output guidance: prefer `image_not_found` over `Error occurred`). This is the single source of truth;
 * both Diagnostic call sites and log call sites reference these constants rather than re-typing string
 * literals, so the two channels can never silently drift apart.
 */
export const Code = {
  // ── envelope contract ────────────────────────────────────────────────────
  /** the outgoing envelope failed its own JSON-Schema validation (a structural bug — should never ship) */
  SCHEMA: "E_SCHEMA",

  // ── dynamic trace (`run`) ────────────────────────────────────────────────
  /** the tracer engine threw — no usable trace was produced */
  ENGINE_FATAL: "ENGINE_FATAL",
  /** a Chrome journey step (goto/click/type/…) failed */
  STEP_FAILED: "STEP_FAILED",
  /** a requested breakpoint never bound at the target (bad file:line, or that line never loads) */
  BP_UNBOUND: "BP_UNBOUND",
  /** breakpoint(s) bound but no event fired — the trigger likely didn't exercise this path (the JSON
   *  counterpart of the renderer's "no breakpoints hit" line, so a `--json` reader sees the why too) */
  BP_BOUND_UNHIT: "BP_BOUND_UNHIT",
  /** writing the Chrome screen + trace-panel recording failed */
  RECORD: "RECORD_FAILED",
  /** nothing was captured to record (no frames) — usually no breakpoint hit during the journey */
  RECORD_EMPTY: "RECORD_EMPTY",
  /** launching headless Chrome failed */
  CHROME: "CHROME_LAUNCH_FAILED",

  // ── static analysis (`graph`/`deps`/`complexity`/`symbols`/`doctor`) ──────
  /** call-graph construction via the LSP call hierarchy failed */
  CODEGRAPH_FAILED: "CODEGRAPH_FAILED",
  /** the call graph hit the depth/size cap and was truncated */
  GRAPH_TRUNCATED: "GRAPH_TRUNCATED",
  /** the language server could not be spawned or connected */
  LSP: "LSP_SPAWN_FAILED",
  /** module-import analysis (madge) failed */
  DEPS_FAILED: "DEPS_FAILED",
  /** circular import group(s) detected */
  DEPS_CIRCULAR: "DEPS_CIRCULAR",
  /** complexity analysis (lizard) failed */
  COMPLEXITY_FAILED: "COMPLEXITY_FAILED",
  /** a function exceeded the complexity threshold */
  COMPLEXITY_HIGH: "COMPLEXITY_HIGH",
  /** symbol outline (tree-sitter) failed */
  SYMBOLS_FAILED: "SYMBOLS_FAILED",
  /** a backing tool is not installed */
  TOOL_MISSING: "TOOL_MISSING",

  // ── collector / storage ──────────────────────────────────────────────────
  /** streaming the envelope to a collector (POST /v1/traces) failed */
  EMIT: "EMIT_FAILED",
  /** the collector could not ingest a posted envelope (parse error / body too large) */
  INGEST: "INGEST_FAILED",
  /** the collector rejected an envelope that did not conform to the schema */
  INGEST_INVALID: "INGEST_INVALID",
  /** the collector rejected an envelope with no meta.sessionId (can't be keyed) */
  INGEST_NO_SESSION: "INGEST_NO_SESSION",
  /** the session store (Postgres) is unavailable or errored */
  STORE: "STORE_UNAVAILABLE",
  /** uploading an artifact (recording) to S3 failed */
  UPLOAD: "UPLOAD_FAILED",
} as const;

export type Code = (typeof Code)[keyof typeof Code];
