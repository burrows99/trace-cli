// Mutation lineage: the normalization-tier view of how watched values change as flow continues.
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeLineage, lineageSummary } from "../src/core/lineage.js";

const ev = (seq, exprs, locals) => ({ seq, t: seq * 10, kind: "breakpoint", attrs: { exprs, locals } });

test("computeLineage tracks a value mutating across hits", () => {
  const events = [
    ev(1, { total: 0 }, { total: 0, i: 0 }),
    ev(2, { total: 9.99 }, { total: 9.99, i: 1 }),
    ev(3, { total: 14.49 }, { total: 14.49, i: 2 }),
  ];
  const lin = computeLineage(events);
  const total = lin.find((t) => t.name === "total");
  assert.ok(total, "total tracked");
  assert.equal(total.kind, "expr", "expr wins over local of same name");
  assert.equal(total.occurrences, 3, "one occurrence per event (not double-counted)");
  assert.equal(total.changes, 2, "0→9.99 and 9.99→14.49");
  assert.equal(lineageSummary(total), "0 → 9.99 → 14.49");
});

test("computeLineage drops values that never change (no lineage without flow)", () => {
  const events = [
    ev(1, { code: "SAVE10" }, { qty: 3 }),
    ev(2, { code: "SAVE10" }, { qty: 3 }),
  ];
  assert.equal(computeLineage(events).length, 0);
});

test("computeLineage returns [] for a single-hit trace", () => {
  assert.equal(computeLineage([ev(1, { total: 5 }, { total: 5 })]).length, 0);
});

test("computeLineage marks each occurrence changed-or-not", () => {
  const events = [ev(1, { x: 1 }), ev(2, { x: 1 }), ev(3, { x: 2 })];
  const x = computeLineage(events).find((t) => t.name === "x");
  assert.deepEqual(x.series.map((s) => s.changed), [false, false, true]);
});
