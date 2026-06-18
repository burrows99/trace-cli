// Static-analysis suite (`trace static …`). The backing tools (madge/lizard/tree-sitter) aren't assumed
// present, so we unit-test the pure parsers against fixtures and assert the tool-missing path degrades to a
// well-formed error-diagnostic envelope. Run via `npm test` (builds first).
import { test } from "node:test";
import assert from "node:assert/strict";

import { DepsCommand } from "../dist/cli/commands/DepsCommand.js";
import { ComplexityCommand } from "../dist/cli/commands/ComplexityCommand.js";
import { SymbolsCommand } from "../dist/cli/commands/SymbolsCommand.js";

test("deps: madge JSON → Graph shape with a circular group detected", () => {
  const map = { "a.ts": ["b.ts", "c.ts"], "b.ts": ["c.ts"], "c.ts": ["a.ts"] };
  const g = DepsCommand.toGraph(map, "a.ts");
  assert.equal(g.stats.modules, 3);
  assert.equal(g.stats.edges, 4); // a→b, a→c, b→c, c→a
  assert.equal(g.stats.circular, 1); // a→b→c→a is one strongly-connected group
  assert.ok(g.edges.some((e) => e.from === "c.ts" && e.to === "a.ts" && e.kind === "imports"));
});

test("deps: acyclic graph reports zero circular groups", () => {
  const g = DepsCommand.toGraph({ "a.ts": ["b.ts"], "b.ts": [] }, "a.ts");
  assert.equal(g.stats.circular, 0);
});

test("complexity: lizard CSV → function Symbols with metrics, header skipped", () => {
  const csv = [
    "NLOC,CCN,token,PARAM,length,location", // header (non-numeric first col) → skipped
    '12,3,80,2,15,"parseThing@10-25@src/a.ts"',
    '40,18,300,4,55,"bigFn@30-90@src/a.ts"',
  ].join("\n");
  const fns = ComplexityCommand.parseCsv(csv);
  assert.equal(fns.length, 2);
  assert.equal(fns[0].name, "parseThing");
  assert.equal(fns[0].loc.file, "src/a.ts");
  assert.equal(fns[0].loc.line, 10);
  assert.equal(fns[0].metrics.find((m) => m.name === "ccn").value, 3);
  assert.equal(fns[0].metrics.find((m) => m.name === "params").value, 2);

  const report = ComplexityCommand.summarize(fns);
  assert.equal(report.stats.functions, 2);
  assert.equal(report.stats.maxCcn, 18);
  assert.equal(report.stats.overThreshold, 1); // bigFn (CCN 18) is over the default threshold of 15
});

test("symbols: tree-sitter sexp + source → named definitions", () => {
  const source = [
    "function alpha(x) {",
    "  return x;",
    "}",
    "class Beta {",
    "  gamma() {}",
    "}",
  ].join("\n");
  const sexp = [
    "(program [0, 0] - [6, 0]",
    "  (function_declaration [0, 0] - [2, 1]",
    "    name: (identifier [0, 9] - [0, 14]))",
    "  (class_declaration [3, 0] - [5, 1]",
    "    name: (type_identifier [3, 6] - [3, 10])",
    "    body: (class_body [3, 11] - [5, 1]",
    "      (method_definition [4, 2] - [4, 11]",
    "        name: (property_identifier [4, 2] - [4, 7])))))",
  ].join("\n");
  const syms = SymbolsCommand.parseSexp(sexp, source, "src/a.ts");
  assert.deepEqual(
    syms.map((s) => `${s.kind} ${s.name} :${s.loc.line}`),
    ["function alpha :1", "class Beta :4", "method gamma :5"],
  );
});

test("deps: a missing tool degrades to a well-formed error envelope (ok:false, valid)", async () => {
  // madge is almost certainly not on PATH in CI — the command must still return a structurally-valid Trace.
  const trace = await new DepsCommand().run({ entry: "definitely-not-a-real-binary-target.ts", root: "/tmp" });
  assert.equal(trace.command, "deps.madge");
  assert.equal(trace.ok, false);
  assert.deepEqual(trace.validate(), []); // envelope is well-formed despite the failure
  assert.ok(trace.diagnostics.some((d) => d.code === "DEPS_FAILED" && d.level === "error"));
});
