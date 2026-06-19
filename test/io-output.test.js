// OutputManager tests — the output tier. It turns a ProcessingResult into an OutputResult descriptor: it runs
// the schema gate (mutating the trace), applies --concise, chooses human-vs-JSON, and computes --json/--html
// file CONTENTS — but writes nothing and never exits. The adapter performs the I/O. (condense itself is unit-
// tested in output.test.js; here we test the descriptor shaping and the gate.)
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";

import { OutputManager } from "../dist/io/OutputManager.js";
import { ProcessingManager } from "../dist/io/ProcessingManager.js";
import { InputManager } from "../dist/io/InputManager.js";
import { Trace } from "../dist/domain/Trace.js";

const om = new OutputManager();
const pm = new ProcessingManager();

test("emit: json:true → stdout is the JSON envelope; a clean trace → exit 0 with no E_SCHEMA diagnostic", async () => {
  const result = await pm.runDoctor();   // doctor is always well-formed + ok:true
  const out = om.emit(result, { json: true });
  assert.equal(JSON.parse(out.stdout).command, "doctor");
  assert.equal(out.exitCode, 0);
  assert.equal(result.trace.diagnostics.filter((d) => d.code === "E_SCHEMA").length, 0);
  assert.deepEqual(out.files, []);
});

test("emit: default (no --json) → stdout is the human render", async () => {
  const result = await pm.runDoctor();
  const out = om.emit(result, {});
  assert.match(out.stdout, /trace-cli doctor/);
});

test("emit: --json <path> → a file descriptor + an 'envelope written' log; stdout stays human", async () => {
  const result = await pm.runDoctor();
  const out = om.emit(result, { json: "/tmp/io-output-test.json" });
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].path, "/tmp/io-output-test.json");
  assert.equal(JSON.parse(out.files[0].contents).command, "doctor");
  assert.ok(out.logs.some((l) => l.message === "envelope written"));
  assert.match(out.stdout, /trace-cli doctor/);   // the file path → stdout stays the human view
});

test("emit: --html on a deps result → a trace-deps-*.html file + a 'deps HTML written' log", async () => {
  const im = new InputManager();
  const result = await pm.runDeps(im.acceptDeps({ entry: "src/io" })); // degrades cleanly if madge is absent
  const out = om.emit(result, { html: true });
  const html = out.files.find((f) => /trace-deps-.*\.html$/.test(f.path));
  assert.ok(html, "expected a deps html file descriptor with a kind-derived temp name");
  assert.ok(html.contents.length > 0);
  assert.ok(out.logs.some((l) => l.message === "deps HTML written"));
});

test("emit: a malformed envelope is caught by the schema gate → E_SCHEMA error, ok:false, exit 1", () => {
  // `version` as a number violates the envelope's @IsString contract, so validate() reports it and the gate
  // turns it into an error diagnostic instead of shipping a silently-malformed Trace.
  const trace = Trace.fromPlain({ tool: "trace", version: 123, command: "x", ok: true, meta: { at: "now" }, data: {}, diagnostics: [] });
  const out = om.emit({ trace, render: () => "x" }, {});
  assert.ok(trace.diagnostics.some((d) => d.code === "E_SCHEMA" && d.level === "error"));
  assert.equal(trace.ok, false);
  assert.equal(out.exitCode, 1);
});

test("text: a literal stdout descriptor with no files and the given exit code", () => {
  const out = om.text("hello", 0);
  assert.equal(out.stdout, "hello");
  assert.deepEqual(out.files, []);
  assert.equal(out.exitCode, 0);
});
