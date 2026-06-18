// Code-graph tests: the default `lsp` provider drives a real language server (typescript-language-server) over
// LSP call hierarchy, building a deterministic outgoing-call graph — resolving across files, deduping shared
// callees, and terminating on recursion. Integration test (spawns the server). Run via `npm test` (builds first).
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { LspCodeGraphProvider } from "../dist/codegraph/LspCodeGraphProvider.js";
import { createCodeGraphProvider, CODEGRAPH_PROVIDERS } from "../dist/codegraph/createCodeGraphProvider.js";
import { GraphCommand } from "../dist/cli/commands/GraphCommand.js";

const ROOT = fileURLToPath(new URL("./fixtures/codegraph", import.meta.url));
const build = (entry, extra) => new LspCodeGraphProvider().callGraph(entry, { root: ROOT, maxDepth: 10, includeExternal: false, maxNodes: 500, ...extra });

// One server spawn shared across the read-only assertions on the main graph.
let mainP;
const main = () => (mainP ??= build({ file: "sample.ts", symbol: "entry" }));
const idByLabel = (g, l) => g.nodes.find((n) => n.label === l)?.id;
const hasEdge = (g, from, to) => g.edges.some((e) => e.from === idByLabel(g, from) && e.to === idByLabel(g, to));

test("lsp provider builds the call graph via LSP call hierarchy, resolving across files", async () => {
  const g = await main();
  assert.equal(g.provider, "lsp");
  const labels = g.nodes.map((n) => n.label).sort();
  assert.deepEqual(labels, ["alpha", "beta", "entry", "gamma", "helperFn", "recur"]);
  assert.ok(hasEdge(g, "entry", "alpha"), "entry → alpha");
  assert.ok(hasEdge(g, "entry", "beta"), "entry → beta");
  assert.ok(hasEdge(g, "entry", "helperFn"), "entry → helperFn (cross-file)");
  assert.ok(hasEdge(g, "alpha", "gamma"), "alpha → gamma");
  assert.ok(hasEdge(g, "beta", "alpha"), "beta → alpha (shared callee, one node)");
  assert.equal(g.stats.external, 0);
});

test("cross-file callee carries the right file; recursion is a terminating self-edge", async () => {
  const g = await main();
  assert.equal(g.nodes.find((n) => n.label === "helperFn").loc.file, "helper.ts");
  assert.ok(hasEdge(g, "recur", "recur"), "recur → recur self-edge present");
  assert.equal(g.nodes.filter((n) => n.label === "recur").length, 1, "graph dedupes: one recur node despite the cycle");
});

test("entry by file:line resolves the same callable as by symbol", async () => {
  const g = await build({ file: "sample.ts", line: 5 }); // `export function entry()`
  assert.equal(g.nodes.find((n) => n.id === g.entry).label, "entry");
});

test("factory selects the lsp provider by name/default and rejects unknown ones", () => {
  assert.equal(createCodeGraphProvider("lsp").name, "lsp");
  assert.equal(createCodeGraphProvider().name, "lsp"); // default is the official LSP path
  assert.throws(() => createCodeGraphProvider("scip"), /unknown code-graph provider/); // removed for now
  assert.throws(() => createCodeGraphProvider("nope"), /unknown code-graph provider/);
  assert.deepEqual([...CODEGRAPH_PROVIDERS], ["lsp"]);
});

test("GraphCommand wraps the graph in a valid envelope and renders a flow tree", async () => {
  const trace = await new GraphCommand().run({
    entry: { file: "sample.ts", symbol: "entry" }, root: ROOT,
    maxDepth: 10, includeExternal: false, maxNodes: 500,
  });
  assert.equal(trace.command, "graph.lsp");
  assert.equal(trace.ok, true);
  assert.equal(trace.validate().length, 0, trace.validate().join("; "));
  const tree = new GraphCommand().render(trace);
  assert.match(tree, /entry/);
  assert.match(tree, /↻ cycle/); // recursion is marked, not expanded forever
});

test("a non-existent entry fails into an error envelope, not a throw", async () => {
  const trace = await new GraphCommand().run({
    entry: { file: "sample.ts", symbol: "doesNotExist" }, root: ROOT,
    maxDepth: 6, includeExternal: false, maxNodes: 500,
  });
  assert.equal(trace.ok, false);
  assert.ok(trace.diagnostics.some((d) => d.code === "CODEGRAPH_FAILED"));
});
