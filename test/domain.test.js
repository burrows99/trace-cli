// Domain + analysis tests against the compiled class-first build (dist/). Run via `npm test` (builds first).
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";

import { Trace, TraceMeta, TraceData, TraceEvent, Breakpoint, Diagnostic, SourceLocation } from "../dist/domain/index.js";
import { Analyzer } from "../dist/analysis/Analyzer.js";
import { LineageAnalyzer } from "../dist/analysis/LineageAnalyzer.js";
import { BreakpointResolver } from "../dist/engine/BreakpointResolver.js";
import { SourceMaps } from "../dist/engine/SourceMaps.js";

test("SourceLocation.parse handles file:line, file:line:column, <native>", () => {
  const a = SourceLocation.parse("src/a.ts:42");
  assert.ok(a instanceof SourceLocation); assert.equal(a.file, "src/a.ts"); assert.equal(a.line, 42);
  const b = SourceLocation.parse("src/a.ts:42:7");
  assert.equal(b.line, 42); assert.equal(b.column, 7);
  assert.equal(SourceLocation.parse("<native>"), undefined);
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
  const t = new Trace({ version: "0.3.0", command: "run.node", diagnostics: [Diagnostic.error("X", "boom")] });
  assert.equal(t.ok, false);
  assert.equal(t.hasErrors(), true);
});

test("Trace.fromPlain rehydrates the full object graph to class instances", () => {
  const t = new Trace({
    version: "0.3.0", command: "run.node",
    meta: new TraceMeta({ at: new Date().toISOString(), sessionId: "s2" }),
    data: new TraceData({
      events: [new TraceEvent({ sequence: 1, kind: "breakpoint", location: SourceLocation.parse("app.js:30"), attributes: { locals: { x: 1 } } })],
      breakpoints: [new Breakpoint({ file: "app.js", line: 30, bound: true })],
    }),
    diagnostics: [Diagnostic.warn("BP_UNBOUND", "y")],
  });
  const back = Trace.fromPlain(JSON.parse(JSON.stringify(t.toJSON())));
  assert.ok(back instanceof Trace);
  assert.ok(back.data.events[0] instanceof TraceEvent);
  assert.ok(back.data.events[0].location instanceof SourceLocation);
  assert.ok(back.diagnostics[0] instanceof Diagnostic);
  assert.equal(back.data.breakpoints[0].line, 30);
});

const ev = (sequence, exprs, locals) => new TraceEvent({ sequence, time: sequence * 10, kind: "breakpoint", attributes: { exprs, locals } });

test("LineageAnalyzer tracks a value mutating across hits (expr wins over local)", () => {
  const analyzer = new LineageAnalyzer();
  assert.ok(analyzer instanceof Analyzer, "LineageAnalyzer extends the shared Analyzer base");
  assert.equal(analyzer.name, "lineage");
  const lin = analyzer.analyze([ev(1, { total: 0 }, { total: 0, i: 0 }), ev(2, { total: 9.99 }, { total: 9.99, i: 1 }), ev(3, { total: 14.49 }, { total: 14.49, i: 2 })]);
  const total = lin.find((t) => t.name === "total");
  assert.equal(total.kind, "expr");
  assert.equal(total.occurrences, 3);
  assert.equal(total.changes, 2);
  assert.equal(LineageAnalyzer.summary(total), "0 → 9.99 → 14.49");
});

test("LineageAnalyzer drops values that never change / single-hit", () => {
  assert.equal(new LineageAnalyzer().analyze([ev(1, { c: "X" }), ev(2, { c: "X" })]).length, 0);
  assert.equal(new LineageAnalyzer().analyze([ev(1, { total: 5 }, { total: 5 })]).length, 0);
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
