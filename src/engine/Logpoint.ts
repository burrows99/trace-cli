import { performance } from "node:perf_hooks";

import type { CdpDriver } from "../transport/CdpDriver.js";
import type { SourceMaps } from "./SourceMaps.js";
import { TraceEvent } from "../domain/TraceEvent.js";
import { SourceLocation } from "../domain/SourceLocation.js";

/** Global the logpoint condition calls to ship a captured hit out over CDP (`Runtime.bindingCalled`). */
export const BINDING_NAME = "__traceCliEmit";
/** Global serializer the condition hands its gathered values to — installed once per execution context. */
const SNAP_NAME = "__traceCliSnap";

/**
 * HELPER_SOURCE — installed once per execution context (via Runtime.evaluate, and per-document for Chrome).
 * Defines {@link SNAP_NAME}: a depth/breadth/cycle-limited serializer that turns the locals & exprs the
 * condition gathered into a JSON envelope and ships it through the {@link BINDING_NAME} binding, then returns
 * `false` so the breakpoint never pauses. Kept dependency-free and ES5-ish so it runs in any V8 context.
 */
export const HELPER_SOURCE = `(function(){
  if (typeof globalThis.${SNAP_NAME} === 'function') return;
  var MAX_STR = 2000, MAX_KEYS = 50, MAX_DEPTH = 4, MAX_ARR = 50;
  function safe(v, d, seen) {
    if (v === null) return null;
    var t = typeof v;
    if (t === 'undefined') return '[undefined]';
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…(' + v.length + ')' : v;
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return v.toString();
    if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Error) return v.name + ': ' + v.message;
    if (d <= 0) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[Object]';
    if (seen.indexOf(v) !== -1) return '[Circular]';
    seen.push(v);
    try {
      if (Array.isArray(v)) {
        var a = [];
        for (var i = 0; i < v.length && i < MAX_ARR; i++) a.push(safe(v[i], d - 1, seen));
        if (v.length > MAX_ARR) a.push('…+' + (v.length - MAX_ARR));
        return a;
      }
      if (typeof Map !== 'undefined' && v instanceof Map) {
        var m = {}, mk = 0;
        v.forEach(function (val, key) { if (mk++ < MAX_KEYS) m[String(key)] = safe(val, d - 1, seen); });
        m['@type'] = 'Map(' + v.size + ')';
        return m;
      }
      if (typeof Set !== 'undefined' && v instanceof Set) {
        var s = []; v.forEach(function (val) { if (s.length < MAX_ARR) s.push(safe(val, d - 1, seen)); });
        return { '@type': 'Set(' + v.size + ')', values: s };
      }
      var o = {}, k = 0, keys = Object.keys(v);
      for (var j = 0; j < keys.length; j++) {
        if (k++ >= MAX_KEYS) { o['…'] = '+' + (keys.length - MAX_KEYS) + ' more'; break; }
        try { o[keys[j]] = safe(v[keys[j]], d - 1, seen); } catch (e) { o[keys[j]] = '⟂'; }
      }
      var ctor = v.constructor && v.constructor.name;
      if (ctor && ctor !== 'Object') o['@type'] = ctor;
      return o;
    } finally { seen.pop(); }
  }
  globalThis.${SNAP_NAME} = function (bp, vals, exprs, err) {
    try {
      var L = {}; for (var n in vals) L[n] = safe(vals[n], MAX_DEPTH, []);
      var E = {}; for (var e in exprs) E[e] = safe(exprs[e], MAX_DEPTH, []);
      globalThis.${BINDING_NAME}(JSON.stringify({ bp: bp, stack: (err && err.stack) || '', locals: L, exprs: E }));
    } catch (_e) {}
    return false;
  };
})();`;

/**
 * Build the breakpoint *condition* that makes a breakpoint behave as a non-pausing logpoint. It gathers the
 * in-scope locals and the user's exprs *defensively* (each in its own try, so a temporal-dead-zone reference
 * or a throwing getter never aborts the capture or — crucially — never throws out of the condition, which V8
 * would treat as "pause"), hands them to the installed serializer with a fresh `new Error()` for the stack,
 * and evaluates to `false`. The `typeof ... === 'function'` guard means that if the helper isn't installed in
 * this context yet, the condition is a silent no-op rather than a throw (again: a throw would pause).
 */
export function buildCondition(breakpointKey: string, locals: string[], exprs: string[]): string {
  const localsObject = locals.length
    ? `(function(){var o={};${locals.map((localName) => `try{o[${JSON.stringify(localName)}]=${localName}}catch(_){}`).join("")}return o})()`
    : "{}";
  const expressionsObject = exprs.length
    ? `(function(){var o={};${exprs.map((expression) => `try{o[${JSON.stringify(expression)}]=(${expression})}catch(_e){o[${JSON.stringify(expression)}]="⟂ "+(_e&&_e.message)}`).join("")}return o})()`
    : "{}";
  return `(typeof globalThis.${SNAP_NAME}==='function'&&${SNAP_NAME}(${JSON.stringify(breakpointKey)},${localsObject},${expressionsObject},new Error()),false)`;
}

interface LogpointPayload { bp: string; stack: string; locals: Record<string, unknown>; exprs: Record<string, unknown>; }

const FRAME_RE = /^\s*at\s+(?:async\s+)?(?:(.*?)\s+)?\(?([^()\s]+):(\d+):(\d+)\)?\s*$/;

/**
 * LogpointCapturer — the non-pausing counterpart to the old EventCapturer: it turns a `bindingCalled`
 * payload (gathered in-page by the condition) into the same {@link TraceEvent} shape the pausing path
 * produced, so everything downstream (Renderer, lineage, the recording's trace panel, the collector,
 * the schema) is untouched. The only difference is provenance — the call stack arrives as a stack string
 * to source-map, not as CDP `callFrames`.
 */
export class LogpointCapturer {
  constructor(private readonly driver: CdpDriver, private readonly sourceMaps: SourceMaps, private readonly startTime: number, private readonly frameLimit = 6) {}

  async toEvent(payloadJson: string, sequence: number): Promise<TraceEvent | null> {
    let payload: LogpointPayload;
    try { payload = JSON.parse(payloadJson); } catch { return null; }
    if (!payload?.bp) return null;
    const location = SourceLocation.parse(payload.bp);
    const stack = await this.#resolveStack(payload.stack);
    const label = stack[0]?.split(" (")[0] || location?.file || payload.bp;
    const exprKeys = Object.keys(payload.exprs ?? {});
    return new TraceEvent({
      sequence, time: Math.round(performance.now() - this.startTime), kind: "breakpoint", source: "cdp",
      location, label,
      attributes: { stack, locals: payload.locals ?? {}, ...(exprKeys.length ? { exprs: payload.exprs } : {}) },
    });
  }

  /** Parse `new Error().stack`, drop synthetic/internal frames (the injected condition, node internals), map the rest. */
  async #resolveStack(rawStack: string): Promise<string[]> {
    const frames: string[] = [];
    for (const line of (rawStack || "").split("\n")) {
      if (frames.length >= this.frameLimit) break;
      const frameMatch = FRAME_RE.exec(line);
      if (!frameMatch) continue;
      const [, functionName, url, lineNumber, column] = frameMatch;
      if (!url || !lineNumber || !column) continue;
      const location = await this.sourceMaps.frameToSource(url, parseInt(lineNumber, 10), parseInt(column, 10));
      if (!location) continue; // synthetic condition-eval frame or a node internal — not user code
      frames.push(`${functionName || "(anon)"} (${location.sourceRel}:${location.line})`);
    }
    return frames;
  }
}
