import { exec } from "node:child_process";
import { performance } from "node:perf_hooks";

import { CdpDriver, renderRemoteObject, log } from "../transport/CdpDriver.js";
import { SourceMaps } from "./SourceMaps.js";
import { BreakpointResolver, type ResolvedBp } from "./BreakpointResolver.js";
import { TraceEvent } from "../domain/TraceEvent.js";
import { Breakpoint } from "../domain/Breakpoint.js";
import { Loc } from "../domain/Loc.js";
import type { TargetKind } from "../domain/Target.js";
import type { ConsoleLine, NetworkLine } from "../domain/Trace.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CurlResult { exitCode: number; body?: string; stderr?: string; error?: string; }

export interface CaptureResult {
  target: TargetKind;
  trigger: string | null;
  breakpoints: Breakpoint[];
  events: TraceEvent[];
  response?: CurlResult;
  console?: ConsoleLine[];
  network?: NetworkLine[];
  finalUrl?: string;
  screenshot?: string;
  finalShot?: string;
  fatal?: string;
}

export interface TraceOptions {
  port: number;
  wsUrl?: string;
  breakpoints?: string[];
  root?: string;
  exprs?: string[];
  steps?: string[];
  frames?: number;
  maxHits?: number;
  timeoutMs?: number;
  attachTimeoutMs?: number;
  reqTimeoutMs?: number;
  curl?: string;
  url?: string;
  shot?: string;
  record?: boolean;
  urlMatch?: string;
  titleMatch?: string;
  sessionId?: string;
  args?: Record<string, unknown>;
}

interface CdpCtx { t0: number; events: TraceEvent[]; frames: number; exprs: string[]; steps: string[]; sm: SourceMaps; bpById: Map<string, { file: string; line: number }>; sessionId?: string; }

function runCurl(cmd: string, ms: number): Promise<CurlResult> {
  return new Promise((res) => {
    exec(cmd, { timeout: ms, maxBuffer: 16 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      res({ exitCode: err?.code ?? 0, body: String(stdout || "").slice(0, 1500), stderr: String(stderr || "").slice(0, 500) || undefined, error: err?.killed ? "timeout" : undefined });
    });
  });
}

const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };

/**
 * Tracer — the trigger+capture engine. Depends on the CdpDriver (ProtocolDriver) via DIP; one capture-loop
 * shape across Node (CDP) and Chrome (CDP). Produces domain entities
 * (TraceEvent, Breakpoint) — the command layer assembles them into a Trace.
 */
export class Tracer {
  // ---- CDP (Node / Chrome) ---------------------------------------------------------------------

  async #settleScripts(driver: CdpDriver, ms = 1500): Promise<void> {
    let prev = -1, stable = 0;
    for (let i = 0; i < ms / 100; i++) {
      const n = driver.scripts().size;
      if (n === prev) { if (++stable >= 3) break; } else stable = 0;
      prev = n;
      await sleep(100);
    }
  }

  async #setCdpBreakpoints(driver: CdpDriver, sm: SourceMaps, bps: ResolvedBp[]): Promise<{ bpById: Map<string, { file: string; line: number }>; report: Breakpoint[] }> {
    const bpById = new Map<string, { file: string; line: number }>();
    const report: Breakpoint[] = [];
    for (const bp of bps) {
      const g = await sm.findGenerated(bp.file, bp.line);
      if (!g) { report.push(new Breakpoint({ file: bp.file, line: bp.line, bound: false, note: "no loaded script/source matched (loaded yet? right file/route?)" })); log(`bp ${bp.file}:${bp.line} → not matched`); continue; }
      const r = await driver.send("Debugger.setBreakpointByUrl", { urlRegex: g.urlRegex, lineNumber: g.lineNumber, columnNumber: g.columnNumber });
      const bound = !!(r.locations && r.locations.length);
      bpById.set(r.breakpointId, { file: bp.file, line: bp.line });
      report.push(new Breakpoint({ file: bp.file, line: bp.line, bound, mapped: g.mapped }));
      log(`bp ${bp.file}:${bp.line} → ${bound ? "BOUND" : "pending"}${g.mapped ? " (mapped)" : ""}`);
    }
    return { bpById, report };
  }

  async #captureCdp(driver: CdpDriver, paused: any, kind: string, ctx: CdpCtx): Promise<TraceEvent> {
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
      const props = await driver.send("Runtime.getProperties", { objectId: sc.object.objectId, ownProperties: true, generatePreview: true });
      for (const p of props.result || []) if (!(p.name in locals)) locals[p.name] = renderRemoteObject(p.value);
    }
    const ex: Record<string, unknown> = {};
    for (const e of ctx.exprs) {
      try {
        const r = await driver.send("Debugger.evaluateOnCallFrame", { callFrameId: top.callFrameId, expression: e, returnByValue: false, generatePreview: true });
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

  async #runSteps(driver: CdpDriver, ctx: CdpCtx, timeoutMs: number): Promise<void> {
    if (ctx.events.length !== 1 || !ctx.steps.length) return;
    for (const s of ctx.steps) {
      const cmd = ({ over: "Debugger.stepOver", into: "Debugger.stepInto", out: "Debugger.stepOut" } as Record<string, string>)[s];
      if (!cmd) continue;
      await driver.send(cmd);
      let st: any;
      try { st = await driver.waitForStop(timeoutMs); } catch { break; }
      if (!st) break;
      ctx.events.push(await this.#captureCdp(driver, st, `step:${s}`, ctx));
    }
  }

  async traceNode(opts: TraceOptions): Promise<CaptureResult> {
    const { port = 9229, wsUrl, curl, breakpoints = [], root, exprs = [], steps = [], frames = 6, maxHits = 25, timeoutMs = 30000, attachTimeoutMs = 8000, reqTimeoutMs = 60000, urlMatch, titleMatch, sessionId } = opts;
    const bps = BreakpointResolver.resolveAll(breakpoints, root);
    const result: CaptureResult = { target: "node", trigger: curl ?? null, breakpoints: [], events: [] };
    const driver = await CdpDriver.connect(wsUrl || (await CdpDriver.resolveWsUrl(port, { kind: "node", urlMatch, titleMatch })), attachTimeoutMs);
    const sm = new SourceMaps(driver, root);
    const ctx: CdpCtx = { t0: performance.now(), events: result.events, frames, exprs, steps, sm, bpById: new Map(), sessionId };
    try {
      await driver.send("Runtime.enable");
      await driver.send("Debugger.enable");
      await driver.send("Debugger.setPauseOnExceptions", { state: "none" });
      await this.#settleScripts(driver);
      const { bpById, report } = await this.#setCdpBreakpoints(driver, sm, bps);
      ctx.bpById = bpById; result.breakpoints = report;

      let triggerDone = !curl;
      let triggerPromise: Promise<void> = Promise.resolve();
      if (curl) {
        ctx.t0 = performance.now();
        log(`fired: ${curl.length > 90 ? curl.slice(0, 90) + "…" : curl}`);
        triggerPromise = runCurl(curl, reqTimeoutMs).then((r) => { result.response = r; }).finally(() => { triggerDone = true; driver.interrupt(); });
      }
      while (result.events.length < maxHits) {
        let paused: any;
        try { paused = await driver.waitForStop(timeoutMs); } catch { break; }
        if (!paused) break;
        result.events.push(await this.#captureCdp(driver, paused, "breakpoint", ctx));
        await this.#runSteps(driver, ctx, timeoutMs);
        await driver.send("Debugger.resume").catch(() => {});
        if (triggerDone && !driver.hasQueued()) break;
      }
      await triggerPromise.catch(() => {});
    } catch (e: any) {
      result.fatal = String(e?.stack || e?.message || e); log("FATAL", result.fatal.split("\n")[0]);
    } finally {
      for (const id of ctx.bpById.keys()) await driver.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
      await driver.send("Debugger.resume").catch(() => {});
      driver.close(); sm.dispose();
    }
    return result;
  }

  async traceChrome(opts: TraceOptions): Promise<CaptureResult> {
    const { port = 9222, wsUrl, url, breakpoints = [], root, exprs = [], steps = [], frames = 6, maxHits = 25, timeoutMs = 15000, attachTimeoutMs = 8000, urlMatch, shot, record = false, sessionId } = opts;
    const waitMs = 3500;
    if (!url) throw new Error("traceChrome requires a page url");
    const bps = BreakpointResolver.resolveAll(breakpoints, root);
    const result: CaptureResult = { target: "chrome", trigger: url, breakpoints: [], events: [], console: [], network: [] };
    const driver = await CdpDriver.connect(wsUrl || (await CdpDriver.resolveWsUrl(port, { kind: "chrome", urlMatch: urlMatch || hostOf(url) })), attachTimeoutMs);
    const sm = new SourceMaps(driver, root);
    const ctx: CdpCtx = { t0: performance.now(), events: result.events, frames, exprs, steps, sm, bpById: new Map(), sessionId };
    driver.on("Runtime.consoleAPICalled", (p: any) => { if (["error", "warning"].includes(p.type)) result.console!.push({ type: p.type, text: (p.args || []).map((a: any) => a.value ?? a.description ?? a.type).join(" ").slice(0, 300) }); });
    driver.on("Runtime.exceptionThrown", (p: any) => result.console!.push({ type: "exception", text: String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "").split("\n")[0].slice(0, 300) }));
    driver.on("Network.responseReceived", (p: any) => { const r = p.response; if (r && r.status >= 400) result.network!.push({ status: r.status, url: r.url }); });
    let loaded = false;
    driver.on("Page.loadEventFired", () => { loaded = true; driver.interrupt(); });
    try {
      await driver.send("Runtime.enable");
      await driver.send("Debugger.enable");
      await driver.send("Page.enable");
      await driver.send("Network.enable");
      await driver.send("Debugger.setPauseOnExceptions", { state: "none" });
      log(`navigating ${url} (load modules)`);
      await driver.send("Page.navigate", { url });
      await sleep(waitMs);
      const { bpById, report } = await this.#setCdpBreakpoints(driver, sm, bps);
      ctx.bpById = bpById; result.breakpoints = report;
      ctx.t0 = performance.now();
      loaded = false;
      log("reloading (trigger)");
      driver.send("Page.reload", {}).catch(() => {});
      while (result.events.length < maxHits) {
        let paused: any;
        try { paused = await driver.waitForStop(loaded ? 1500 : timeoutMs); } catch { break; }
        if (paused === null) continue;
        result.events.push(await this.#captureCdp(driver, paused, "breakpoint", ctx));
        await this.#runSteps(driver, ctx, timeoutMs);
        await driver.send("Debugger.resume").catch(() => {});
      }
      await driver.send("Debugger.resume").catch(() => {});
      await sleep(1500);
      try { const u = await driver.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }); result.finalUrl = u.result?.value; } catch { /* ignore */ }
      if (shot || record) {
        const data = await this.#snap(driver);
        if (data) { if (record) result.finalShot = data; if (shot) { (await import("node:fs")).writeFileSync(shot, Buffer.from(data, "base64")); result.screenshot = shot; } }
      }
    } catch (e: any) {
      result.fatal = String(e?.stack || e?.message || e); log("FATAL", result.fatal.split("\n")[0]);
    } finally {
      for (const id of ctx.bpById.keys()) await driver.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
      await driver.send("Debugger.resume").catch(() => {});
      driver.close(); sm.dispose();
    }
    return result;
  }

  async #snap(driver: CdpDriver): Promise<string | null> {
    try { return (await driver.send("Page.captureScreenshot", { format: "png" })).data; } catch { return null; }
  }
}
