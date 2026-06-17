// Pure unit smoke tests (no network / no debug target). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBpSpec, parseBreakpoints, suffixMatch, pathOf, urlRegexFor } from "../src/index.js";

test("parseBpSpec splits file:line, and prefers @ for colon-bearing substrings", () => {
  assert.deepEqual(parseBpSpec("src/a.ts:149"), { file: "src/a.ts", lineSpec: "149" });
  assert.deepEqual(parseBpSpec("src/a.ts@fetchData"), { file: "src/a.ts", lineSpec: "fetchData" });
  assert.deepEqual(parseBpSpec("src/a.ts@foo: bar"), { file: "src/a.ts", lineSpec: "foo: bar" });
  assert.throws(() => parseBpSpec("noseparator"));
});

test("pathOf strips scheme / authority / query", () => {
  assert.equal(pathOf("file:///app/dist/x.js"), "app/dist/x.js");
  assert.equal(pathOf("http://localhost:3000/src/x.tsx?t=1"), "src/x.tsx");
  assert.equal(pathOf("src/plain.ts"), "src/plain.ts");
});

test("suffixMatch matches trailing segments both directions, ignoring scheme + ../", () => {
  assert.ok(suffixMatch("file:///app/dist/dashboard/x.js", "dist/dashboard/x.js"));
  assert.ok(suffixMatch("../src/dashboard/x.ts", "src/dashboard/x.ts"));
  assert.ok(suffixMatch("../src/dashboard/x.ts", "hesta-api/src/dashboard/x.ts")); // shorter is a suffix of longer
  assert.ok(!suffixMatch("src/a/x.ts", "src/b/x.ts"));
});

test("urlRegexFor builds a path regex that matches the full script URL", () => {
  const rx = new RegExp(urlRegexFor("file:///app/dist/dashboard/x.js"));
  assert.ok(rx.test("file:///app/dist/dashboard/x.js"));
  assert.ok(rx.test("file:///app/dist/dashboard/x.js?v=1"));
  assert.ok(!rx.test("file:///app/dist/dashboard/xNYjs"));
});

test("parseBreakpoints: numeric + substring against disk; errors on missing/ambiguous", () => {
  const root = mkdtempSync(join(tmpdir(), "trace-bp-"));
  try {
    writeFileSync(join(root, "f.ts"), "const a = 1;\nfunction fetchData() {\n  return a;\n}\n");
    assert.equal(parseBreakpoints(["f.ts:3"], root)[0].line, 3);
    assert.equal(parseBreakpoints(["f.ts@fetchData"], root)[0].line, 2);
    assert.throws(() => parseBreakpoints(["f.ts@nope"], root), /no line/);
    assert.throws(() => parseBreakpoints(["missing.ts@x"], root), /not readable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
