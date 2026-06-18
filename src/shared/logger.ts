/**
 * Logger — a production-grade, zero-dependency structured logger. It writes to **stderr only**, so stdout stays
 * the pure data channel the CLI owns (the Trace envelope / human render). Output is env-driven:
 *   TRACE_LOG_LEVEL   debug | info | warn | error | silent   (default: info)
 *   TRACE_LOG_FORMAT  json | pretty                          (default: pretty on a TTY, else json)
 * Bind per-component context with child({ component: "collector" }); time spans with timer(). Pass a `code`
 * field (from the shared {@link Code} registry) to tag a line with the same stable, greppable code the
 * envelope's diagnostics use — it renders prominently (JSON: hoisted after `level`; pretty: `[E_…]` before
 * the message) so a human or an agent can correlate an execution log with the result it produced.
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
type EmitLevel = Exclude<LogLevel, "silent">;
type Fields = Record<string, unknown>;

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLOR: Record<EmitLevel, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

/** Resolve the threshold each emit, so TRACE_LOG_LEVEL can be changed at runtime (and tests can override it). */
function threshold(): number {
  const configuredLevel = (process.env.TRACE_LOG_LEVEL || "").toLowerCase();
  return WEIGHT[(configuredLevel in WEIGHT ? configuredLevel : "info") as LogLevel];
}
function format(): "json" | "pretty" {
  const configuredFormat = (process.env.TRACE_LOG_FORMAT || "").toLowerCase();
  if (configuredFormat === "json" || configuredFormat === "pretty") return configuredFormat;
  return process.stderr.isTTY ? "pretty" : "json";
}

/** Errors anywhere in the fields are expanded to { name, message, stack } so they survive JSON.stringify. */
function normalize(fields: Fields): Fields {
  const normalized: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    normalized[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
  }
  return normalized;
}

export class Logger {
  constructor(private readonly context: Fields = {}) {}

  /** Derive a logger that carries extra context (merged into every line). */
  child(context: Fields): Logger {
    return new Logger({ ...this.context, ...context });
  }

  /** Start a span; the returned fn emits `message` with a measured `durationMs` field. */
  timer(): (level: EmitLevel, message: string, fields?: Fields) => void {
    const startedAt = Date.now();
    return (level, message, fields) => this.#emit(level, message, { ...fields, durationMs: Date.now() - startedAt });
  }

  debug(message: string, fields?: Fields): void { this.#emit("debug", message, fields); }
  info(message: string, fields?: Fields): void { this.#emit("info", message, fields); }
  warn(message: string, fields?: Fields): void { this.#emit("warn", message, fields); }
  error(message: string, fields?: Fields): void { this.#emit("error", message, fields); }

  #emit(level: EmitLevel, message: string, fields: Fields = {}): void {
    if (WEIGHT[level] < threshold()) return;
    const merged = normalize({ ...this.context, ...fields });
    // Hoist `code` out of the field bag so it renders once, prominently — never duplicated in the kv tail.
    const code = typeof merged.code === "string" ? merged.code : undefined;
    if (code !== undefined) delete merged.code;
    const timestamp = new Date().toISOString();
    if (format() === "json") {
      // `code` sits right after `level` so a machine can key on it; it's the same vocabulary the envelope uses.
      process.stderr.write(JSON.stringify({ ts: timestamp, level, ...(code ? { code } : {}), msg: message, ...merged }) + "\n");
      return;
    }
    const isTty = process.stderr.isTTY;
    const levelTag = level.toUpperCase().padEnd(5);
    const head = isTty ? `${COLOR[level]}${levelTag}${RESET}` : levelTag;
    const codeTag = code ? ` [${code}]` : "";
    const keyValues = Object.entries(merged)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    process.stderr.write(`${timestamp} ${head}${codeTag} ${message}${keyValues ? "  " + keyValues : ""}\n`);
  }
}

/** The root logger. Prefer `logger.child({ component: "…" })` at module scope in each component. */
export const logger = new Logger();
