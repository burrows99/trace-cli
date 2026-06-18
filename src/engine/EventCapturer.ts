import { performance } from "node:perf_hooks";

import { CdpDriver, renderRemoteObject } from "../transport/CdpDriver.js";
import { Cdp } from "../transport/cdp.js";
import { SourceMaps } from "./SourceMaps.js";
import { TraceEvent } from "../domain/TraceEvent.js";
import { Loc } from "../domain/Loc.js";

/**
 * CdpCtx — the per-trace mutable context the EventCapturer reads while turning CDP pauses into events:
 * the clock origin, the running event list, frame/expr/step budgets, the SourceMaps resolver, the
 * breakpoint-id → source-loc map (grown as breakpoints bind), and the session id.
 */
export interface CdpCtx {
  t0: number;
  events: TraceEvent[];
  frames: number;
  exprs: string[];
  steps: string[];
  sm: SourceMaps;
  bpById: Map<string, { file: string; line: number }>;
  sessionId?: string;
}

/**
 * EventCapturer — turns a CDP `Debugger.paused` event into a domain TraceEvent: walks the call stack,
 * extracts locals from the scope chain, evaluates watch expressions, and resolves the hit location through
 * source maps; also drives the step (over/into/out) plan at the first hit. The driver is injected (DIP).
 * SRP: pause → TraceEvent(s) only — it owns nothing about the capture loop, triggers, or teardown.
 */
export class EventCapturer {
  constructor(private readonly driver: CdpDriver) {}

  async capture(paused: any, kind: string, ctx: CdpCtx): Promise<TraceEvent> {
    const driver = this.driver;
    const top = paused.callFrames[0];
    const stack: string[] = [];
    for (const f of paused.callFrames.slice(0, ctx.frames)) {
      const url = driver.scriptUrl(f.location.scriptId) || f.url;
      const loc = await ctx.sm.generatedToSource(f.location.scriptId, f.location.lineNumber, f.location.columnNumber);
      const at = loc ? `${loc.sourceRel}:${loc.line}` : (url ? `${SourceMaps.pathOf(url)}:${f.location.lineNumber + 1}` : "<native>");
      stack.push(`${f.functionName || "(anon)"} (${at})`);
    }
    const locals: Record<string, unknown> = {};
    for (const sc of top.scopeChain) {
      if (!["local", "block", "catch"].includes(sc.type) || !sc.object?.objectId) continue;
      const props = await driver.send(Cdp.Runtime.getProperties, { objectId: sc.object.objectId, ownProperties: true, generatePreview: true });
      for (const p of props.result || []) if (!(p.name in locals)) locals[p.name] = renderRemoteObject(p.value);
    }
    const ex: Record<string, unknown> = {};
    for (const e of ctx.exprs) {
      try {
        const r = await driver.send(Cdp.Debugger.evaluateOnCallFrame, { callFrameId: top.callFrameId, expression: e, returnByValue: false, generatePreview: true });
        ex[e] = r.exceptionDetails ? `⟂ ${String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "error").split("\n")[0]}` : renderRemoteObject(r.result);
      } catch (err: any) { ex[e] = `⟂ ${err.message}`; }
    }
    const loc = await ctx.sm.generatedToSource(top.location.scriptId, top.location.lineNumber, top.location.columnNumber);
    const labelBp = (paused.hitBreakpoints || []).map((id: string) => ctx.bpById.get(id)).filter(Boolean)[0];
    const at = loc ? `${loc.sourceRel}:${loc.line}` : (labelBp ? `${labelBp.file}:${labelBp.line}` : stack[0]);
    const cls = top.this?.className && top.this.className !== "Object" ? top.this.className : undefined;
    return new TraceEvent({
      seq: ctx.events.length + 1, t: Math.round(performance.now() - ctx.t0), kind, source: "cdp", sessionId: ctx.sessionId,
      loc: Loc.parse(at), label: top.functionName || "(anonymous)",
      attrs: { ...(cls ? { cls } : {}), stack, locals, ...(ctx.exprs.length ? { exprs: ex } : {}) },
    });
  }

  async runSteps(ctx: CdpCtx, timeoutMs: number): Promise<void> {
    if (ctx.events.length !== 1 || !ctx.steps.length) return;
    for (const s of ctx.steps) {
      const cmd = ({ over: Cdp.Debugger.stepOver, into: Cdp.Debugger.stepInto, out: Cdp.Debugger.stepOut } as Record<string, string>)[s];
      if (!cmd) continue;
      await this.driver.send(cmd);
      let st: any;
      try { st = await this.driver.waitForStop(timeoutMs); } catch { break; }
      if (!st) break;
      ctx.events.push(await this.capture(st, `step:${s}`, ctx));
    }
  }
}
