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
import { discoverSourceFiles, resolveRepoRoot, isDirectory } from "../dist/codegraph/sourceFiles.js";

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
  assert.equal(g.nodes.find((n) => n.label === "helperFn").location.file, "helper.ts");
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

// ── repo map: the whole-directory mode ───────────────────────────────────────────────────────────────────────

test("discoverSourceFiles walks a directory (extension-filtered) and resolveRepoRoot detects the project root", () => {
  const found = discoverSourceFiles(ROOT, { maxFiles: 100 });
  assert.deepEqual(found.files.map((f) => f.split(/[/\\]/).pop()).sort(), ["helper.ts", "sample.ts"]);
  assert.equal(found.truncated, false);
  assert.equal(discoverSourceFiles(ROOT, { maxFiles: 1 }).truncated, true, "the file cap flips truncated");
  assert.ok(isDirectory(ROOT) && !isDirectory(ROOT + "/sample.ts"));
  // a file resolves to its nearest project root (this repo's root has package.json/tsconfig/.git)
  assert.ok(resolveRepoRoot(ROOT + "/sample.ts").length > 0);
});

test("repoGraph maps every file's symbols with containment + call edges (mode: repo, no single entry)", async () => {
  const g = await new LspCodeGraphProvider().repoGraph({ root: ROOT, maxFiles: 100, maxNodes: 500 });
  assert.equal(g.mode, "repo");
  assert.equal(g.entry, "", "a repo map has no single entry");
  assert.equal(g.stats.files, 2);
  // file nodes exist, and each contains its top-level functions
  const fileNode = g.nodes.find((n) => n.kind === "file" && n.id === "sample.ts");
  assert.ok(fileNode, "sample.ts is a file node");
  const entryNode = g.nodes.find((n) => n.label === "entry" && n.kind === "function");
  assert.ok(entryNode, "entry is a function node");
  assert.ok(g.edges.some((e) => e.kind === "contains" && e.from === "sample.ts" && e.to === entryNode.id), "file contains entry");
  // call edges are present too (entry → alpha), and counted per kind
  const alpha = g.nodes.find((n) => n.label === "alpha");
  assert.ok(g.edges.some((e) => e.kind === "calls" && e.from === entryNode.id && e.to === alpha.id), "entry → alpha (calls)");
  assert.ok((g.stats.edgeKinds.contains ?? 0) > 0 && (g.stats.edgeKinds.calls ?? 0) > 0);
});

test("GraphCommand repo mode → a valid envelope rendered as a per-file outline", async () => {
  const trace = await new GraphCommand().run({ repo: true, root: ROOT, maxDepth: 6, maxNodes: 500 });
  assert.equal(trace.command, "graph.lsp");
  assert.equal(trace.ok, true);
  assert.equal(trace.validate().length, 0, trace.validate().join("; "));
  const out = new GraphCommand().render(trace);
  assert.match(out, /repo map/);
  assert.match(out, /sample\.ts/);
  assert.match(out, /entry.*→ calls/);
});
