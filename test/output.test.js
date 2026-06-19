// Output-policy tests: the `--concise` envelope transform and the shared Code vocabulary.
// Against the compiled build (dist/). Run via `npm test` (builds first).
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";

import { condense } from "../dist/cli/Cli.js";
import { Code } from "../dist/shared/codes.js";
import { Collector } from "../dist/collector/Collector.js";

/** A trace-shaped plain envelope with two breakpoint hits (full locals + a 5-frame stack + a watched expr). */
function fullEnvelope() {
  return {
    tool: "trace", command: "run.node", ok: true,
    data: {
      events: [
        {
          sequence: 1, kind: "breakpoint", location: { file: "src/a.ts", line: 10 }, label: "handler",
          attributes: {
            stack: ["handler (src/a.ts:10)", "route (src/r.ts:4)", "dispatch (src/d.ts:9)", "mw (src/m.ts:2)", "server (src/s.ts:7)"],
            locals: { userId: 42, cart: { items: 3, total: 99 }, token: "secret" },
            exprs: { "cart.length": 3 },
          },
        },
        {
          sequence: 2, kind: "breakpoint", location: { file: "src/a.ts", line: 20 }, label: "save",
          attributes: { stack: ["save (src/a.ts:20)"], locals: { ok: true } },
        },
      ],
    },
    diagnostics: [],
  };
}

test("condense: locals collapse to key names, stack caps at top frames, exprs kept", () => {
  const out = condense(fullEnvelope());
  const [hit1, hit2] = out.data.events;

  // hit1: 3 locals -> localsKeys (names only), raw values dropped
  assert.deepEqual(hit1.attributes.localsKeys, ["userId", "cart", "token"]);
  assert.equal(hit1.attributes.locals, undefined, "raw locals values must be dropped");

  // 5-frame stack -> top 2 + a depth count so it never looks complete-but-truncated
  assert.equal(hit1.attributes.stack.length, 2);
  assert.equal(hit1.attributes.stackDepth, 5);

  // watched --expr values are high-signal and kept verbatim
  assert.deepEqual(hit1.attributes.exprs, { "cart.length": 3 });

  // location/label/sequence are untouched
  assert.equal(hit1.label, "handler");
  assert.deepEqual(hit1.location, { file: "src/a.ts", line: 10 });

  // hit2: a 1-frame stack is under the cap, so it is left as-is (no stackDepth added)
  assert.equal(hit2.attributes.stack.length, 1);
  assert.equal(hit2.attributes.stackDepth, undefined);
  assert.deepEqual(hit2.attributes.localsKeys, ["ok"]);
});

test("condense: no-ops on an envelope without breakpoint events (static analyses)", () => {
  const staticEnv = { tool: "trace", command: "deps.madge", ok: true, data: { deps: { nodes: [], edges: [] } }, diagnostics: [] };
  const out = condense(staticEnv);
  assert.deepEqual(out, staticEnv, "static envelopes pass through unchanged");
});

test("Code registry: stable, unique, greppable values shared by both channels", () => {
  const values = Object.values(Code);
  assert.equal(new Set(values).size, values.length, "code values must be unique");
  // the envelope's existing diagnostic codes are part of the one vocabulary
  assert.equal(Code.CODEGRAPH_FAILED, "CODEGRAPH_FAILED");
  assert.equal(Code.BP_UNBOUND, "BP_UNBOUND");
  assert.equal(Code.BP_BOUND_UNHIT, "BP_BOUND_UNHIT");
  assert.equal(Code.SCHEMA, "E_SCHEMA");
});

test("Collector.emit: a failed POST resolves to a rich result (never throws, never a bare bool)", async () => {
  // Port 1 is unbound → fetch rejects (connection refused). emit must catch it and return a structured
  // result so the caller can surface *why* an emit failed instead of swallowing a `false`.
  const result = await Collector.emit("http://127.0.0.1:1", { tool: "trace" });
  assert.equal(result.ok, false, "a refused emit is not ok");
  assert.equal(typeof result.error, "string", "the failure reason is carried back, not dropped");
  assert.ok(result.error.length > 0, "error message is non-empty");
});
