// The trace engine: set breakpoints, fire a trigger, capture every pause as a structured trace.
// Generalized from the original debug engine — Node target (curl trigger) and Chrome target (navigate
// trigger) share one capture loop. Library functions: they return data and never call process.exit.

import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { connect, resolveWsUrl, renderRO, log } from "./cdp.js";
import { findGenerated, generatedToSource, pathOf, disposeConsumers, setRoot } from "./sourcemaps.js";
import { parseBreakpoints } from "./breakpoints.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

// snap(client): base64 PNG of the page (works while paused at a breakpoint). null on failure.
async function snap(client) {
  try { return (await client.send("Page.captureScreenshot", { format: "png" })).data; } catch { return null; }
}

// settleScripts: after Debugger.enable the target replays scriptParsed for already-loaded scripts;
// wait until the count stops growing so source-map resolution sees everything.
async function settleScripts(client, ms = 1500) {
  let prev = -1, stable = 0;
  for (let i = 0; i < ms / 100; i++) {
    const n = client.scripts().size;
    if (n === prev) { if (++stable >= 3) break; } else stable = 0;
    prev = n;
    await sleep(100);
  }
}

async function setBreakpoints(client, bps) {
  const bpById = new Map();
  const report = [];
  for (const bp of bps) {
    const g = await findGenerated(client, bp.file, bp.line);
    if (!g) {
      report.push({ file: bp.file, line: bp.line, bound: false, note: "no loaded script/source matched (loaded yet? right file/route?)" });
      log(`bp ${bp.file}:${bp.line} → not matched`);
      continue;
    }
    const r = await client.send("Debugger.setBreakpointByUrl", { urlRegex: g.urlRegex, lineNumber: g.lineNumber, columnNumber: g.columnNumber });
    const bound = !!(r.locations && r.locations.length);
    bpById.set(r.breakpointId, { file: bp.file, line: bp.line });
    report.push({ file: bp.file, line: bp.line, bound, mapped: g.mapped });
    log(`bp ${bp.file}:${bp.line} → ${bound ? "BOUND" : "pending"}${g.mapped ? " (mapped)" : ""}`);
  }
  return { bpById, report };
}

async function capture(client, paused, kind, ctx) {
  const { bpById, frames, exprs } = ctx;
  const top = paused.callFrames[0];

  const stack = [];
  for (const f of paused.callFrames.slice(0, frames)) {
    const url = client.scriptUrl(f.location.scriptId) || f.url;
    const loc = await generatedToSource(client, f.location.scriptId, f.location.lineNumber, f.location.columnNumber);
    const at = loc ? `${loc.sourceRel}:${loc.line}` : (url ? `${pathOf(url)}:${f.location.lineNumber + 1}` : "<native>");
    stack.push(`${f.functionName || "(anon)"} (${at})`);
  }

  const locals = {};
  for (const sc of top.scopeChain) {
    if (!["local", "block", "catch"].includes(sc.type) || !sc.object?.objectId) continue;
    const props = await client.send("Runtime.getProperties", { objectId: sc.object.objectId, ownProperties: true, generatePreview: true });
    for (const p of props.result || []) if (!(p.name in locals)) locals[p.name] = renderRO(p.value);
  }

  const ex = {};
  for (const e of exprs) {
    try {
      const r = await client.send("Debugger.evaluateOnCallFrame", { callFrameId: top.callFrameId, expression: e, returnByValue: false, generatePreview: true });
      ex[e] = r.exceptionDetails ? `⟂ ${String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "error").split("\n")[0]}` : renderRO(r.result);
    } catch (err) { ex[e] = `⟂ ${err.message}`; }
  }

  const loc = await generatedToSource(client, top.location.scriptId, top.location.lineNumber, top.location.columnNumber);
  const labelBp = (paused.hitBreakpoints || []).map((id) => bpById.get(id)).filter(Boolean)[0];
  return {
    seq: ctx.hits.length + 1, kind,
    at: loc ? `${loc.sourceRel}:${loc.line}` : (labelBp ? `${labelBp.file}:${labelBp.line}` : stack[0]),
    fn: top.functionName || "(anonymous)",
    cls: top.this?.className && top.this.className !== "Object" ? top.this.className : undefined,
    tMs: Math.round(performance.now() - ctx.t0),
    stack, locals, exprs: exprs.length ? ex : undefined,
  };
}

async function runSteps(client, ctx, timeoutMs, record = false) {
  if (ctx.hits.length !== 1 || !ctx.steps.length) return;
  for (const s of ctx.steps) {
    const cmd = { over: "Debugger.stepOver", into: "Debugger.stepInto", out: "Debugger.stepOut" }[s];
    if (!cmd) continue;
    await client.send(cmd);
    let st;
    try { st = await client.waitForPaused(timeoutMs); } catch { break; }
    const h = await capture(client, st, `step:${s}`, ctx);
    if (record) h.shot = await snap(client);
    ctx.hits.push(h);
  }
}

function runCurl(cmd, ms) {
  return new Promise((res) => {
    exec(cmd, { timeout: ms, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      res({
        exitCode: err?.code ?? 0,
        body: String(stdout || "").slice(0, 1500),
        stderr: String(stderr || "").slice(0, 500) || undefined,
        error: err?.killed ? "timeout" : undefined,
      });
    });
  });
}

// traceNode({ port, wsUrl, curl, breakpoints, root, exprs, steps, frames, maxHits, timeoutMs,
//   reqTimeoutMs, urlMatch, titleMatch }) → trace result. Trigger = the curl command (a subprocess).
export async function traceNode(opts = {}) {
  const {
    port = 9229, wsUrl, curl, breakpoints = [], root,
    exprs = [], steps = [], frames = 6, maxHits = 25,
    timeoutMs = 30000, reqTimeoutMs = 60000, urlMatch, titleMatch,
  } = opts;
  setRoot(root);
  const bps = parseBreakpoints(breakpoints, root);
  const result = { meta: { at: stamp(), target: "node", trigger: curl || null, breakpoints: bps.map((b) => b.raw), exprs, steps }, breakpoints: [], hits: [] };

  const client = await connect(wsUrl || (await resolveWsUrl(port, { kind: "node", urlMatch, titleMatch })));
  const ctx = { bpById: null, t0: performance.now(), hits: result.hits, frames, exprs, steps };
  try {
    await client.send("Runtime.enable");
    await client.send("Debugger.enable");
    await client.send("Debugger.setPauseOnExceptions", { state: "none" });
    await settleScripts(client);
    const { bpById, report } = await setBreakpoints(client, bps);
    ctx.bpById = bpById; result.breakpoints = report;

    let triggerDone = !curl;
    let triggerPromise = Promise.resolve();
    if (curl) {
      ctx.t0 = performance.now();
      log(`fired: ${curl.length > 90 ? curl.slice(0, 90) + "…" : curl}`);
      triggerPromise = runCurl(curl, reqTimeoutMs).then((r) => { result.response = r; }).finally(() => { triggerDone = true; });
    }
    while (result.hits.length < maxHits) {
      let paused;
      try { paused = await client.waitForPaused(timeoutMs); } catch { break; }
      result.hits.push(await capture(client, paused, "breakpoint", ctx));
      await runSteps(client, ctx, timeoutMs);
      await client.send("Debugger.resume").catch(() => {});
      if (triggerDone && !client.hasQueued()) break;
    }
    await triggerPromise.catch(() => {});
  } catch (e) {
    result.fatal = String(e?.stack || e?.message || e);
    log("FATAL", result.fatal.split("\n")[0]);
  } finally {
    if (ctx.bpById) for (const id of ctx.bpById.keys()) await client.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
    await client.send("Debugger.resume").catch(() => {});
    client.close();
    disposeConsumers();
  }
  return result;
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

// traceChrome({ port, wsUrl, url, breakpoints, root, exprs, steps, frames, maxHits, timeoutMs, waitMs,
//   shot, urlMatch }) → trace result. Trigger = navigate to `url` then reload. Also captures
//   console errors/warnings, uncaught exceptions, failed (≥400) responses, and an optional screenshot.
export async function traceChrome(opts = {}) {
  const {
    port = 9222, wsUrl, url, breakpoints = [], root,
    exprs = [], steps = [], frames = 6, maxHits = 25,
    timeoutMs = 15000, waitMs = 3500, shot, urlMatch, record = false,
  } = opts;
  if (!url) throw new Error("traceChrome requires a page url");
  setRoot(root);
  const bps = parseBreakpoints(breakpoints, root);
  const result = { meta: { at: stamp(), target: "chrome", trigger: url, breakpoints: bps.map((b) => b.raw), exprs, steps }, breakpoints: [], hits: [], console: [], network: [] };

  const client = await connect(wsUrl || (await resolveWsUrl(port, { kind: "chrome", urlMatch: urlMatch || hostOf(url) })));
  const ctx = { bpById: null, t0: performance.now(), hits: result.hits, frames, exprs, steps };
  client.on("Runtime.consoleAPICalled", (p) => { if (["error", "warning"].includes(p.type)) result.console.push({ type: p.type, text: (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 300) }); });
  client.on("Runtime.exceptionThrown", (p) => result.console.push({ type: "exception", text: String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "").split("\n")[0].slice(0, 300) }));
  client.on("Network.responseReceived", (p) => { const r = p.response; if (r && r.status >= 400) result.network.push({ status: r.status, url: r.url }); });
  try {
    await client.send("Runtime.enable");
    await client.send("Debugger.enable");
    await client.send("Page.enable");
    await client.send("Network.enable");
    await client.send("Debugger.setPauseOnExceptions", { state: "none" });

    log(`navigating ${url} (load modules)`);
    await client.send("Page.navigate", { url });
    await sleep(waitMs);

    const { bpById, report } = await setBreakpoints(client, bps);
    ctx.bpById = bpById; result.breakpoints = report;

    ctx.t0 = performance.now();
    log("reloading (trigger)");
    client.send("Page.reload", {}).catch(() => {});

    while (result.hits.length < maxHits) {
      let paused;
      try { paused = await client.waitForPaused(timeoutMs); } catch { break; }
      const hit = await capture(client, paused, "breakpoint", ctx);
      if (record) hit.shot = await snap(client);
      result.hits.push(hit);
      await runSteps(client, ctx, timeoutMs, record);
      await client.send("Debugger.resume").catch(() => {});
    }
    await sleep(1500);
    try { const u = await client.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }); result.finalUrl = u.result?.value; } catch {}
    if (shot) { try { const s = await client.send("Page.captureScreenshot", { format: "png" }); writeFileSync(shot, Buffer.from(s.data, "base64")); result.screenshot = shot; } catch {} }
  } catch (e) {
    result.fatal = String(e?.stack || e?.message || e);
    log("FATAL", result.fatal.split("\n")[0]);
  } finally {
    if (ctx.bpById) for (const id of ctx.bpById.keys()) await client.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
    await client.send("Debugger.resume").catch(() => {});
    client.close();
    disposeConsumers();
  }
  return result;
}

// checkBreakpoint({ kind, port, wsUrl, url, file, line, root, waitMs }) → { file, line, bound, mapped,
//   scriptUrl }. Resolves a single breakpoint and verifies it binds, then detaches. For preflight.
export async function checkBreakpoint(opts = {}) {
  const { kind = "node", port, wsUrl, url, file, root, waitMs = 3500 } = opts;
  setRoot(root);
  const [bp] = parseBreakpoints([`${file}@${opts.lineSpec ?? opts.line}`], root);
  const client = await connect(wsUrl || (await resolveWsUrl(port ?? (kind === "chrome" ? 9222 : 9229), { kind, urlMatch: kind === "chrome" ? hostOf(url) : undefined })));
  try {
    await client.send("Debugger.enable");
    if (kind === "chrome" && url) { await client.send("Page.enable"); await client.send("Page.navigate", { url }); await sleep(waitMs); }
    else await settleScripts(client);
    const g = await findGenerated(client, bp.file, bp.line);
    if (!g) return { file: bp.file, line: bp.line, bound: false };
    const r = await client.send("Debugger.setBreakpointByUrl", { urlRegex: g.urlRegex, lineNumber: g.lineNumber, columnNumber: g.columnNumber });
    const bound = !!(r.locations && r.locations.length);
    await client.send("Debugger.removeBreakpoint", { breakpointId: r.breakpointId }).catch(() => {});
    return { file: bp.file, line: bp.line, bound, mapped: g.mapped, scriptUrl: g.scriptUrl };
  } finally { client.close(); disposeConsumers(); }
}
