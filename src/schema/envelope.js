// The contract. Every subcommand emits the SAME envelope; only `data` varies, and `data` is built from a
// small set of shared shapes (Loc / Symbol / Metric / Graph / Event) so every consumer learns one
// vocabulary. See docs/MIGRATION.md §4 and src/schema/trace.schema.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")).version;

const iso = () => new Date().toISOString();

// newSessionId() → a fresh id grouping every event of one run. The unit of cross-source / cross-language
// correlation: a frontend (cdp) session and the backend (dap) session it triggered share an id so their
// events join into one timeline. See docs/MIGRATION.md "North star".
export const newSessionId = () => randomUUID();

// makeEnvelope({ command, target, data, args, diagnostics, ok, startedAtMs, toolVersions, sessionId })
// → envelope. `command` is a dotted id ("dynamic.python", "static.complexity"). `ok` defaults to
// (no error diagnostics).
export function makeEnvelope({
  command, target = null, data = {}, args = {},
  diagnostics = [], ok, startedAtMs, toolVersions = {}, sessionId,
}) {
  const errored = diagnostics.some((d) => d.level === "error");
  return {
    tool: "trace",
    version: VERSION,
    command,
    ok: ok ?? !errored,
    meta: {
      at: iso(),
      ...(sessionId ? { sessionId } : {}),
      args,
      durationMs: startedAtMs != null ? Math.round(performance.now() - startedAtMs) : undefined,
      toolVersions,
    },
    target,
    data,
    diagnostics,
  };
}

// ---- shared shapes (the vocabulary) -------------------------------------------------------------

// Loc: a source location. `file:line` is parsed back into this everywhere.
export function loc(file, line, extra = {}) {
  if (file == null) return undefined;
  return { file, ...(line != null ? { line } : {}), ...extra };
}

// parseLoc("src/a.ts:149") → { file, line }. Tolerates trailing :col and "<native>".
export function parseLoc(at) {
  if (!at || at === "<native>") return undefined;
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(at);
  if (!m) return { file: at };
  return loc(m[1], Number(m[2]), m[3] ? { col: Number(m[3]) } : {});
}

// Event: the timeline primitive. A CDP breakpoint hit, a DAP stop, an OTel span, and a Playwright action
// all become Events on one timeline. `source` tags the collector that produced it (cdp/dap/terminal/otel)
// and `sessionId` groups a run — together they make cross-source, cross-language correlation expressible.
export function event({ seq, t, kind, at, label, attrs, source, sessionId, traceId, spanId, parentSpanId }) {
  return {
    seq, t, kind, label,
    ...(source ? { source } : {}),
    ...(sessionId ? { sessionId } : {}),
    loc: typeof at === "string" ? parseLoc(at) : at,
    ...(attrs ? { attrs } : {}),
    ...(traceId ? { traceId } : {}),
    ...(spanId ? { spanId } : {}),
    ...(parentSpanId ? { parentSpanId } : {}),
  };
}

export const metric = (name, value, unit) => ({ name, value, ...(unit ? { unit } : {}) });

export const diag = (level, code, message) => ({ level, code, message });

// ---- lightweight self-validation (dep-free; structural) -----------------------------------------

const LEVELS = new Set(["info", "warn", "error"]);

// validate(env) → string[] of problems (empty = valid). Used in tests to keep every subcommand honest.
export function validate(env) {
  const errs = [];
  const req = (cond, msg) => { if (!cond) errs.push(msg); };
  req(env && typeof env === "object", "envelope must be an object");
  if (!env || typeof env !== "object") return errs;
  req(env.tool === "trace", 'tool must be "trace"');
  req(typeof env.version === "string", "version must be a string");
  req(typeof env.command === "string" && env.command.length > 0, "command must be a non-empty string");
  req(typeof env.ok === "boolean", "ok must be a boolean");
  req(env.meta && typeof env.meta === "object", "meta must be an object");
  req(env.meta && typeof env.meta.at === "string", "meta.at must be an ISO string");
  req("target" in env, "target must be present (may be null)");
  req(env.data && typeof env.data === "object", "data must be an object");
  req(Array.isArray(env.diagnostics), "diagnostics must be an array");
  for (const d of env.diagnostics || []) {
    req(d && LEVELS.has(d.level), `diagnostic.level must be one of ${[...LEVELS].join("/")}`);
    req(d && typeof d.code === "string", "diagnostic.code must be a string");
  }
  return errs;
}
