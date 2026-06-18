/**
 * Logger — a production-grade, zero-dependency structured logger. It writes to **stderr only**, so stdout stays
 * the pure data channel the CLI owns (the Trace envelope / human render). Output is env-driven:
 *   TRACE_LOG_LEVEL   debug | info | warn | error | silent   (default: info)
 *   TRACE_LOG_FORMAT  json | pretty                          (default: pretty on a TTY, else json)
 * Bind per-component context with child({ component: "collector" }); time spans with timer().
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
type EmitLevel = Exclude<LogLevel, "silent">;
type Fields = Record<string, unknown>;

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLOR: Record<EmitLevel, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

/** Resolve the threshold each emit, so TRACE_LOG_LEVEL can be changed at runtime (and tests can override it). */
function threshold(): number {
  const v = (process.env.TRACE_LOG_LEVEL || "").toLowerCase();
  return WEIGHT[(v in WEIGHT ? v : "info") as LogLevel];
}
function format(): "json" | "pretty" {
  const v = (process.env.TRACE_LOG_FORMAT || "").toLowerCase();
  if (v === "json" || v === "pretty") return v;
  return process.stderr.isTTY ? "pretty" : "json";
}

/** Errors anywhere in the fields are expanded to { name, message, stack } so they survive JSON.stringify. */
function normalize(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  return out;
}

export class Logger {
  constructor(private readonly context: Fields = {}) {}

  /** Derive a logger that carries extra context (merged into every line). */
  child(context: Fields): Logger {
    return new Logger({ ...this.context, ...context });
  }

  /** Start a span; the returned fn emits `msg` with a measured `durationMs` field. */
  timer(): (level: EmitLevel, msg: string, fields?: Fields) => void {
    const start = Date.now();
    return (level, msg, fields) => this.#emit(level, msg, { ...fields, durationMs: Date.now() - start });
  }

  debug(msg: string, fields?: Fields): void { this.#emit("debug", msg, fields); }
  info(msg: string, fields?: Fields): void { this.#emit("info", msg, fields); }
  warn(msg: string, fields?: Fields): void { this.#emit("warn", msg, fields); }
  error(msg: string, fields?: Fields): void { this.#emit("error", msg, fields); }

  #emit(level: EmitLevel, msg: string, fields: Fields = {}): void {
    if (WEIGHT[level] < threshold()) return;
    const merged = normalize({ ...this.context, ...fields });
    const ts = new Date().toISOString();
    if (format() === "json") {
      process.stderr.write(JSON.stringify({ ts, level, msg, ...merged }) + "\n");
      return;
    }
    const tty = process.stderr.isTTY;
    const tag = level.toUpperCase().padEnd(5);
    const head = tty ? `${COLOR[level]}${tag}${RESET}` : tag;
    const kv = Object.entries(merged)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    process.stderr.write(`${ts} ${head} ${msg}${kv ? "  " + kv : ""}\n`);
  }
}

/** The root logger. Prefer `logger.child({ component: "…" })` at module scope in each component. */
export const logger = new Logger();
