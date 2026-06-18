import { performance } from "node:perf_hooks";

import type { CdpDriver } from "../transport/CdpDriver.js";
import type { SourceMaps } from "./SourceMaps.js";
import { TraceEvent } from "../domain/TraceEvent.js";
import { Loc } from "../domain/Loc.js";

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
  var MAXSTR = 2000, MAXKEYS = 50, MAXDEPTH = 4, MAXARR = 50;
  function safe(v, d, seen) {
    if (v === null) return null;
    var t = typeof v;
    if (t === 'undefined') return '[undefined]';
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'string') return v.length > MAXSTR ? v.slice(0, MAXSTR) + '…(' + v.length + ')' : v;
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
        for (var i = 0; i < v.length && i < MAXARR; i++) a.push(safe(v[i], d - 1, seen));
        if (v.length > MAXARR) a.push('…+' + (v.length - MAXARR));
        return a;
      }
      if (typeof Map !== 'undefined' && v instanceof Map) {
        var m = {}, mk = 0;
        v.forEach(function (val, key) { if (mk++ < MAXKEYS) m[String(key)] = safe(val, d - 1, seen); });
        m['@type'] = 'Map(' + v.size + ')';
        return m;
      }
      if (typeof Set !== 'undefined' && v instanceof Set) {
        var s = []; v.forEach(function (val) { if (s.length < MAXARR) s.push(safe(val, d - 1, seen)); });
        return { '@type': 'Set(' + v.size + ')', values: s };
      }
      var o = {}, k = 0, keys = Object.keys(v);
      for (var j = 0; j < keys.length; j++) {
        if (k++ >= MAXKEYS) { o['…'] = '+' + (keys.length - MAXKEYS) + ' more'; break; }
        try { o[keys[j]] = safe(v[keys[j]], d - 1, seen); } catch (e) { o[keys[j]] = '⟂'; }
      }
      var ctor = v.constructor && v.constructor.name;
      if (ctor && ctor !== 'Object') o['@type'] = ctor;
      return o;
    } finally { seen.pop(); }
  }
  globalThis.${SNAP_NAME} = function (bp, vals, exprs, err) {
    try {
      var L = {}; for (var n in vals) L[n] = safe(vals[n], MAXDEPTH, []);
      var E = {}; for (var e in exprs) E[e] = safe(exprs[e], MAXDEPTH, []);
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
export function buildCondition(bpKey: string, locals: string[], exprs: string[]): string {
  const vals = locals.length
    ? `(function(){var o={};${locals.map((n) => `try{o[${JSON.stringify(n)}]=${n}}catch(_){}`).join("")}return o})()`
    : "{}";
  const ex = exprs.length
    ? `(function(){var o={};${exprs.map((e) => `try{o[${JSON.stringify(e)}]=(${e})}catch(_e){o[${JSON.stringify(e)}]="⟂ "+(_e&&_e.message)}`).join("")}return o})()`
    : "{}";
  return `(typeof globalThis.${SNAP_NAME}==='function'&&${SNAP_NAME}(${JSON.stringify(bpKey)},${vals},${ex},new Error()),false)`;
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
  constructor(private readonly driver: CdpDriver, private readonly sm: SourceMaps, private readonly t0: number, private readonly frames = 6) {}

  async toEvent(payloadJson: string, seq: number): Promise<TraceEvent | null> {
    let p: LogpointPayload;
    try { p = JSON.parse(payloadJson); } catch { return null; }
    if (!p?.bp) return null;
    const loc = Loc.parse(p.bp);
    const stack = await this.#resolveStack(p.stack);
    const label = stack[0]?.split(" (")[0] || loc?.file || p.bp;
    const exprKeys = Object.keys(p.exprs ?? {});
    return new TraceEvent({
      seq, t: Math.round(performance.now() - this.t0), kind: "breakpoint", source: "cdp",
      loc, label,
      attrs: { stack, locals: p.locals ?? {}, ...(exprKeys.length ? { exprs: p.exprs } : {}) },
    });
  }

  /** Parse `new Error().stack`, drop synthetic/internal frames (the injected condition, node internals), map the rest. */
  async #resolveStack(raw: string): Promise<string[]> {
    const out: string[] = [];
    for (const line of (raw || "").split("\n")) {
      if (out.length >= this.frames) break;
      const m = FRAME_RE.exec(line);
      if (!m) continue;
      const [, fn, url, ln, col] = m;
      if (!url || !ln || !col) continue;
      const loc = await this.sm.frameToSource(url, parseInt(ln, 10), parseInt(col, 10));
      if (!loc) continue; // synthetic condition-eval frame or a node internal — not user code
      out.push(`${fn || "(anon)"} (${loc.sourceRel}:${loc.line})`);
    }
    return out;
  }
}
