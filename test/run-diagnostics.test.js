// RunCommand diagnostics: a trace run must make its failures legible in the envelope (not just stderr),
// and a thrown run must emit a TERMINAL envelope so the dashboard's "running" session resolves instead of
// hanging forever. Injects a fake tracer so we exercise the envelope/diagnostic logic without a real CDP target.
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";

import { RunCommand } from "../dist/cli/commands/RunCommand.js";
import { TargetKind } from "../dist/domain/Target.js";

const fakeTracer = (behavior) => ({
  async traceNode() { return behavior(); },
  async traceChrome() { return behavior(); },
});

const nodeCapture = (over = {}) => ({ target: TargetKind.Node, trigger: "curl localhost", breakpoints: [], events: [], ...over });

test("a thrown run emits a TERMINAL envelope (running cleared, ENGINE_FATAL) so the dashboard resolves", async () => {
  const seen = [];
  const cmd = new RunCommand(fakeTracer(() => { throw new Error("attach failed: ECONNREFUSED"); }));

  await assert.rejects(
    cmd.run({ target: TargetKind.Node, port: 9229, onProgress: (t) => seen.push(t) }),
    /attach failed/,
  );

  // The first envelope is the initial running partial; the last must be the terminal abort.
  assert.ok(seen.length >= 2, "expected an initial running partial AND a terminal abort envelope");
  assert.equal(seen[0].meta.running, true, "the first envelope is the running partial");
  const terminal = seen[seen.length - 1];
  assert.notEqual(terminal.meta.running, true, "the terminal envelope is NOT running — the session resolves");
  assert.equal(terminal.ok, false, "a terminal abort is not ok");
  assert.ok(
    terminal.diagnostics.some((d) => d.code === "ENGINE_FATAL" && d.level === "error"),
    "the terminal envelope carries an ENGINE_FATAL error",
  );
});

test("a captured fatal (no throw) yields ok:false + an ENGINE_FATAL diagnostic in the envelope", async () => {
  const cmd = new RunCommand(fakeTracer(() => nodeCapture({ fatal: "debugger disconnected" })));
  const { trace } = await cmd.run({ target: TargetKind.Node, port: 9229 });
  assert.equal(trace.ok, false);
  assert.ok(trace.diagnostics.some((d) => d.code === "ENGINE_FATAL"));
});

test("a clean empty node trace stays ok:true and not running (no false alarms)", async () => {
  const cmd = new RunCommand(fakeTracer(() => nodeCapture()));
  const { trace } = await cmd.run({ target: TargetKind.Node, port: 9229 });
  assert.equal(trace.ok, true);
  assert.equal(trace.meta.running, undefined, "the final envelope is not flagged running");
});
