// `trace dynamic` — protocol-pluggable breakpoint tracer. Selects the engine by target (Node CDP,
// Chrome CDP, Python DAP), runs it, and normalizes the engine's rich internal result into the unified
// envelope. The engine keeps emitting its own shape (so render.js/record.js are untouched); this module
// is the thin normalization seam at the CLI edge.

import { traceNode, traceChrome, tracePython } from "../engine/trace.js";
import { makeEnvelope, event, newSessionId } from "../schema/envelope.js";

// The collector that produced an event, by target. CDP for the JS family, DAP for everything else.
const SOURCE_OF = { node: "cdp", chrome: "cdp", python: "dap" };

// hitToEvent(hit, { source, sessionId }) → Event. Lossless map of an engine hit onto the timeline
// primitive (see MIGRATION §4), tagged with its collector + session for cross-source correlation.
function hitToEvent(h, { source, sessionId }) {
  return event({
    seq: h.seq, t: h.tMs, kind: h.kind, at: h.at, label: h.fn, source, sessionId,
    attrs: {
      ...(h.cls ? { cls: h.cls } : {}),
      stack: h.stack,
      locals: h.locals,
      ...(h.exprs ? { exprs: h.exprs } : {}),
    },
  });
}

// dynamicEnvelope(result, { args, startedAtMs, sessionId }) → unified envelope for a dynamic trace.
export function dynamicEnvelope(result, { args = {}, startedAtMs, sessionId = newSessionId() } = {}) {
  const kind = result.meta?.target || "node";
  const source = SOURCE_OF[kind] || "dap";
  const diagnostics = [];
  if (result.fatal) diagnostics.push({ level: "error", code: "ENGINE_FATAL", message: String(result.fatal).split("\n")[0] });
  for (const b of (result.breakpoints || []).filter((b) => !b.bound)) {
    diagnostics.push({ level: "warn", code: "BP_UNBOUND", message: `${b.file}:${b.line} did not bind${b.note ? " — " + b.note : ""}` });
  }
  const data = {
    breakpoints: result.breakpoints || [],
    events: (result.hits || []).map((h) => hitToEvent(h, { source, sessionId })),
    ...(result.response ? { response: result.response } : {}),
    ...(result.console ? { console: result.console } : {}),
    ...(result.network ? { network: result.network } : {}),
    ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
    ...(result.screenshot ? { screenshot: result.screenshot } : {}),
  };
  return makeEnvelope({
    command: `dynamic.${kind}`,
    target: { kind, source, trigger: result.meta?.trigger || null },
    data, args, diagnostics, startedAtMs, sessionId, ok: !result.fatal,
  });
}

// runDynamic(opts) → { result, envelope }. opts.target ∈ node|chrome|python; the rest are engine options.
// opts.sessionId lets a caller correlate this run with others (e.g. a frontend trace and the backend it
// triggered); one is minted if absent.
export async function runDynamic(opts) {
  const startedAtMs = performance.now();
  const sessionId = opts.sessionId || newSessionId();
  let result;
  if (opts.target === "chrome") result = await traceChrome(opts);
  else if (opts.target === "python") result = await tracePython(opts);
  else result = await traceNode(opts);
  return { result, envelope: dynamicEnvelope(result, { args: opts.args || {}, startedAtMs, sessionId }), sessionId };
}
