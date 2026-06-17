// Contract tests: the unified envelope, shared shapes, and the dynamic normalizer. No network / no debug
// target — pure shape checks that keep every subcommand honest against src/schema/trace.schema.json.
import { test } from "node:test";
import assert from "node:assert/strict";

import { makeEnvelope, validate, event, parseLoc, newSessionId, dynamicEnvelope } from "../src/index.js";

test("makeEnvelope produces a valid envelope, with sessionId under meta", () => {
  const env = makeEnvelope({ command: "doctor", data: { tools: [] }, sessionId: "s1" });
  assert.equal(validate(env).length, 0, validate(env).join("; "));
  assert.equal(env.tool, "trace");
  assert.equal(env.command, "doctor");
  assert.equal(env.ok, true);
  assert.equal(env.meta.sessionId, "s1");
});

test("validate flags a malformed envelope", () => {
  assert.ok(validate({}).length > 0);
  assert.ok(validate({ tool: "nope", command: "x", ok: true, meta: { at: "" }, target: null, data: {}, diagnostics: [] }).length > 0);
});

test("ok defaults to false when an error diagnostic is present", () => {
  const env = makeEnvelope({ command: "dynamic.node", diagnostics: [{ level: "error", code: "X", message: "boom" }] });
  assert.equal(env.ok, false);
});

test("event tags source + sessionId and parses `at` into a Loc", () => {
  const e = event({ seq: 1, t: 5, kind: "breakpoint", at: "src/a.ts:42", label: "f", source: "dap", sessionId: "s2" });
  assert.equal(e.source, "dap");
  assert.equal(e.sessionId, "s2");
  assert.deepEqual(e.loc, { file: "src/a.ts", line: 42 });
});

test("parseLoc handles file:line, file:line:col, and <native>", () => {
  assert.deepEqual(parseLoc("src/a.ts:42"), { file: "src/a.ts", line: 42 });
  assert.deepEqual(parseLoc("src/a.ts:42:7"), { file: "src/a.ts", line: 42, col: 7 });
  assert.equal(parseLoc("<native>"), undefined);
});

test("newSessionId returns distinct ids", () => {
  assert.notEqual(newSessionId(), newSessionId());
});

test("dynamicEnvelope maps an engine result → a valid, source-tagged envelope", () => {
  const result = {
    meta: { target: "python", trigger: "curl ..." },
    breakpoints: [{ file: "app.py", line: 30, bound: true }],
    hits: [{ seq: 1, kind: "breakpoint", at: "app.py:30", fn: "price_for", tMs: 12, stack: ["price_for (app.py:30)"], locals: { qty: "3" }, exprs: { rate: "0.1" } }],
    response: { exitCode: 0, body: "{}" },
  };
  const env = dynamicEnvelope(result, { sessionId: "s3" });
  assert.equal(validate(env).length, 0, validate(env).join("; "));
  assert.equal(env.command, "dynamic.python");
  assert.equal(env.target.source, "dap");
  assert.equal(env.meta.sessionId, "s3");
  const e = env.data.events[0];
  assert.equal(e.source, "dap");
  assert.equal(e.sessionId, "s3");
  assert.deepEqual(e.loc, { file: "app.py", line: 30 });
  assert.equal(e.attrs.locals.qty, "3");
});

test("dynamicEnvelope surfaces an unbound breakpoint as a warn diagnostic", () => {
  const env = dynamicEnvelope({ meta: { target: "node" }, breakpoints: [{ file: "a.js", line: 9, bound: false }], hits: [] });
  assert.ok(env.diagnostics.some((d) => d.level === "warn" && d.code === "BP_UNBOUND"));
});
