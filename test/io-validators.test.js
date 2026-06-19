// Validator tests — the validation halves split out of the managers. InputValidator owns the run guards + the
// strict DTO/step/graph checks (throwing InputError); OutputValidator owns the envelope schema gate. The
// managers (io-input/io-output) test the wiring; here we test the rules in isolation, at the validator boundary.
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";

import { InputValidator } from "../dist/io/InputValidator.js";
import { OutputValidator } from "../dist/io/OutputValidator.js";
import { InputError } from "../dist/io/InputError.js";
import { TargetKind } from "../dist/domain/Target.js";
import { Trace, TraceData, TraceMeta } from "../dist/domain/Trace.js";

const iv = new InputValidator();
const ov = new OutputValidator();
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return undefined; };
const runRaw = (over = {}) => ({ breakpoint: ["app.js:10"], expression: [], step: [], ...over });

test("InputValidator.guardRunFlags: throws on a target conflict, passes a clean combo", () => {
  assert.ok(thrown(() => iv.guardRunFlags(runRaw({ node: true, chrome: true }))) instanceof InputError);
  assert.equal(iv.guardRunFlags(runRaw({ node: true })), undefined);
});

test("InputValidator.guardRunTrigger: requires a breakpoint first, then the target's trigger", () => {
  const error = thrown(() => iv.guardRunTrigger(runRaw({ breakpoint: [] }), { target: TargetKind.Node, isChrome: false, steps: [] }));
  assert.ok(error instanceof InputError);
  assert.match(error.message, /at least one --breakpoint/);
  // a node target with a curl trigger is clean
  assert.equal(iv.guardRunTrigger(runRaw({ curl: "c" }), { target: TargetKind.Node, isChrome: false, steps: [] }), undefined);
});

test("InputValidator.validateRun: an out-of-range port throws InputError carrying the problems", () => {
  const error = thrown(() => iv.validateRun({ target: TargetKind.Node, port: 70000, breakpoints: ["a:1"], exprs: [], steps: [] }));
  assert.ok(error instanceof InputError);
  assert.match(error.message, /^invalid input —/);
  assert.ok(error.problems.length >= 1);
});

test("InputValidator.validateSteps: an unknown verb throws an invalid-step InputError; a known journey passes", () => {
  const error = thrown(() => iv.validateSteps(["frobnicate:x"]));
  assert.ok(error instanceof InputError);
  assert.match(error.message, /^invalid step —/);
  assert.equal(iv.validateSteps(["goto:http://x", "click:#go"]), undefined);
});

test("InputValidator.validateGraph: requires a line or a symbol", () => {
  assert.ok(thrown(() => iv.validateGraph({ file: "a.ts" })) instanceof InputError);
  assert.equal(iv.validateGraph({ file: "a.ts", symbol: "foo" }), undefined);
  assert.equal(iv.validateGraph({ file: "a.ts", line: 3 }), undefined);
});

test("InputValidator.requireDepsEntry / requireSymbolsFile: presence gates with their exact wording", () => {
  assert.equal(thrown(() => iv.requireDepsEntry("")).message, "deps needs --entry <file|dir>");
  assert.equal(iv.requireDepsEntry("src"), undefined);
  assert.equal(thrown(() => iv.requireSymbolsFile(undefined)).message, "symbols needs a <file>");
  assert.equal(iv.requireSymbolsFile("a.ts"), undefined);
});

test("OutputValidator.gate: a clean trace is untouched; a malformed one gets E_SCHEMA + ok:false", () => {
  const clean = new Trace({ version: "0", command: "run.node", meta: new TraceMeta({ at: "2026-01-01T00:00:00.000Z" }), data: new TraceData({ events: [] }), ok: true });
  ov.gate(clean);
  assert.equal(clean.ok, true);
  assert.equal(clean.diagnostics.filter((d) => d.code === "E_SCHEMA").length, 0);

  // `version` as a number violates @IsString → the gate records it and flips ok.
  const bad = Trace.fromPlain({ tool: "trace", version: 123, command: "x", ok: true, meta: { at: "now" }, data: {}, diagnostics: [] });
  ov.gate(bad);
  assert.ok(bad.diagnostics.some((d) => d.code === "E_SCHEMA" && d.level === "error"));
  assert.equal(bad.ok, false);
});
