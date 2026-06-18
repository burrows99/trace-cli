// Domain + analysis tests against the compiled class-first build (dist/). Run via `npm test` (builds first).
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";

import { Trace, TraceMeta, TraceData, TraceEvent, Breakpoint, Diagnostic, Loc } from "../dist/domain/index.js";
import { LineageAnalyzer } from "../dist/analysis/LineageAnalyzer.js";
import { BreakpointResolver } from "../dist/engine/BreakpointResolver.js";
import { SourceMaps } from "../dist/engine/SourceMaps.js";
import { Recorder } from "../dist/engine/Recorder.js";

test("Loc.parse handles file:line, file:line:col, <native>", () => {
  const a = Loc.parse("src/a.ts:42");
  assert.ok(a instanceof Loc); assert.equal(a.file, "src/a.ts"); assert.equal(a.line, 42);
  const b = Loc.parse("src/a.ts:42:7");
  assert.equal(b.line, 42); assert.equal(b.col, 7);
  assert.equal(Loc.parse("<native>"), undefined);
});

test("Trace.toJSON produces a valid envelope; validate() passes", () => {
  const t = new Trace({
    version: "0.3.0", command: "doctor",
    meta: new TraceMeta({ at: new Date().toISOString(), sessionId: "s1" }),
    data: new TraceData({ tools: [] }),
  });
  const json = t.toJSON();
  assert.equal(json.tool, "trace");
  assert.equal(json.command, "doctor");
  assert.equal(t.ok, true);
  assert.equal(t.validate().length, 0, t.validate().join("; "));
});

test("Trace.ok defaults to false when an error diagnostic is present", () => {
  const t = new Trace({ version: "0.3.0", command: "dynamic.node", diagnostics: [Diagnostic.error("X", "boom")] });
  assert.equal(t.ok, false);
  assert.equal(t.hasErrors(), true);
});

test("Trace.fromPlain rehydrates the full object graph to class instances", () => {
  const t = new Trace({
    version: "0.3.0", command: "dynamic.node",
    meta: new TraceMeta({ at: new Date().toISOString(), sessionId: "s2" }),
    data: new TraceData({
      events: [new TraceEvent({ seq: 1, kind: "breakpoint", loc: Loc.parse("app.js:30"), attrs: { locals: { x: 1 } } })],
      breakpoints: [new Breakpoint({ file: "app.js", line: 30, bound: true })],
    }),
    diagnostics: [Diagnostic.warn("BP_UNBOUND", "y")],
  });
  const back = Trace.fromPlain(JSON.parse(JSON.stringify(t.toJSON())));
  assert.ok(back instanceof Trace);
  assert.ok(back.data.events[0] instanceof TraceEvent);
  assert.ok(back.data.events[0].loc instanceof Loc);
  assert.ok(back.diagnostics[0] instanceof Diagnostic);
  assert.equal(back.data.breakpoints[0].line, 30);
});

const ev = (seq, exprs, locals) => new TraceEvent({ seq, t: seq * 10, kind: "breakpoint", attrs: { exprs, locals } });

test("LineageAnalyzer tracks a value mutating across hits (expr wins over local)", () => {
  const lin = LineageAnalyzer.compute([ev(1, { total: 0 }, { total: 0, i: 0 }), ev(2, { total: 9.99 }, { total: 9.99, i: 1 }), ev(3, { total: 14.49 }, { total: 14.49, i: 2 })]);
  const total = lin.find((t) => t.name === "total");
  assert.equal(total.kind, "expr");
  assert.equal(total.occurrences, 3);
  assert.equal(total.changes, 2);
  assert.equal(LineageAnalyzer.summary(total), "0 → 9.99 → 14.49");
});

test("LineageAnalyzer drops values that never change / single-hit", () => {
  assert.equal(LineageAnalyzer.compute([ev(1, { c: "X" }), ev(2, { c: "X" })]).length, 0);
  assert.equal(LineageAnalyzer.compute([ev(1, { total: 5 }, { total: 5 })]).length, 0);
});

test("BreakpointResolver.parseSpec splits file:line and file@substring", () => {
  assert.deepEqual(BreakpointResolver.parseSpec("src/a.ts:149"), { file: "src/a.ts", lineSpec: "149" });
  assert.deepEqual(BreakpointResolver.parseSpec("src/a.ts@fetchData"), { file: "src/a.ts", lineSpec: "fetchData" });
  assert.throws(() => BreakpointResolver.parseSpec("noseparator"));
});

test("SourceMaps static helpers (pathOf, suffixMatch, urlRegexFor)", () => {
  assert.equal(SourceMaps.pathOf("http://localhost:3000/src/x.tsx?t=1"), "src/x.tsx");
  assert.ok(SourceMaps.suffixMatch("file:///app/dist/dashboard/x.js", "dist/dashboard/x.js"));
  assert.ok(!SourceMaps.suffixMatch("src/a/x.ts", "src/b/x.ts"));
  assert.ok(new RegExp(SourceMaps.urlRegexFor("file:///app/x.js")).test("file:///app/x.js?v=1"));
});

test("Recorder.wrap + concatList", () => {
  assert.deepEqual(Recorder.wrap("a b c d e", 3), ["a b", "c d", "e"]);
  assert.match(Recorder.concatList(["/f0.png", "/f1.png"], 3, 2), /duration 2[\s\S]*duration 3[\s\S]*file '\/f1.png'/);
});
