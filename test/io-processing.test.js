// ProcessingManager tests — the orchestration tier. Owns the collector wiring (resolve + serialized emit chain
// + onProgress + the failure→diagnostic fold), the abort path (EngineAbortError), the static collector forward,
// and the command render thunks. The DynamicCommand is injected (a fake, like dynamic-diagnostics.test.js) and
// Collector's static helpers are stubbed so no real network is touched. `node --test` isolates each file in its
// own process, so these stubs never leak into other suites.
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ProcessingManager, EngineAbortError } from "../dist/io/ProcessingManager.js";
import { InputManager } from "../dist/io/InputManager.js";
import { Collector } from "../dist/collector/Collector.js";
import { Trace, TraceData, TraceMeta } from "../dist/domain/Trace.js";

const mkTrace = () => new Trace({
  version: "0.0.0", command: "run.node",
  meta: new TraceMeta({ at: "2026-01-01T00:00:00.000Z" }),
  data: new TraceData({ events: [] }), ok: true,
});
// A duck-typed DynamicCommand: `run` is the injected behavior, `render` proves the thunk is bound to it.
const fakeDynamic = (run) => ({ run, render: (trace) => `rendered:${trace.command}` });

test("runDynamic: with no collector → returns the trace and a render thunk bound to the command", async () => {
  Collector.resolve = async () => null;   // nothing configured, nothing discovered
  const trace = mkTrace();
  const pm = new ProcessingManager(fakeDynamic(async () => ({ trace })));
  const result = await pm.runDynamic({ request: { target: "node" }, emit: null });
  assert.equal(result.trace, trace);
  assert.equal(result.render(), "rendered:run.node");
});

test("runDynamic: a throwing run rejects with EngineAbortError carrying the cause", async () => {
  Collector.resolve = async () => null;
  const pm = new ProcessingManager(fakeDynamic(async () => { throw new Error("attach failed"); }));
  await assert.rejects(
    () => pm.runDynamic({ request: { target: "node" }, emit: null }),
    (error) => error instanceof EngineAbortError && error.code === "ENGINE_FATAL" && /attach failed/.test(error.message),
  );
});

test("runDynamic: a failing collector emit folds into an EMIT warn diagnostic on the returned trace", async () => {
  const emitted = [];
  Collector.resolve = async () => "http://collector.test";
  Collector.emit = async (_url, envelope) => { emitted.push(envelope); return { ok: false, status: 400, body: "bad envelope" }; };
  const trace = mkTrace();
  // The fake streams one running envelope (onProgress), then returns the final one — both POSTs fail.
  const pm = new ProcessingManager(fakeDynamic(async (opts) => { opts.onProgress?.(trace); return { trace }; }));

  const result = await pm.runDynamic({ request: { target: "node" }, emit: null });
  assert.ok(emitted.length >= 1, "the collector should have received at least one envelope");
  const emitDiag = result.trace.diagnostics.find((d) => d.code === "EMIT_FAILED");
  assert.ok(emitDiag && emitDiag.level === "warn", "a failed emit must surface as an EMIT warn diagnostic");
  assert.match(emitDiag.message, /rejected .*HTTP 400/);
});

test("forwardStatic: forwards to TRACE_COLLECTOR_URL when set (explicit-only), no-ops otherwise", async () => {
  const forwarded = [];
  Collector.emit = async (url) => { forwarded.push(url); return { ok: true, status: 200 }; };
  const pm = new ProcessingManager();
  const trace = mkTrace();

  delete process.env.TRACE_COLLECTOR_URL;
  await pm.forwardStatic(trace);
  assert.equal(forwarded.length, 0, "no env → no forward (a static analysis has no sessionId to ingest)");

  process.env.TRACE_COLLECTOR_URL = "http://static.test";
  await pm.forwardStatic(trace);
  assert.deepEqual(forwarded, ["http://static.test"]);
  delete process.env.TRACE_COLLECTOR_URL;
});

test("static runs return render thunks; deps additionally exposes renderHtml", async () => {
  const pm = new ProcessingManager();
  const im = new InputManager();

  const doctor = await pm.runDoctor();
  assert.equal(doctor.trace.command, "doctor");
  assert.equal(typeof doctor.render, "function");
  assert.equal(doctor.renderHtml, undefined);

  const deps = await pm.runDeps(im.acceptDeps({ entry: "src/io" })); // degrades cleanly if madge is absent
  assert.equal(typeof deps.renderHtml, "function");
  assert.ok(deps.renderHtml().length > 0);
});
