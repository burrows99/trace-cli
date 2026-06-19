// Export test: `exports` provisions a project's .claude/skills/trace with the skill AND interactive HTML maps
// (graph.html via the repo LSP map, deps.html via madge) built from the target project. Integration test
// (spawns the language server; madge may be absent → its page degrades but is still written). Run via `npm test`.
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExportCommand } from "../dist/cli/commands/ExportCommand.js";

test("exports copies the skill and writes graph.html + deps.html into the export directory", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "trace-export-"));
  try {
    // a tiny TS project so the repo map has a real symbol to render
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "app.ts"), "export function greet(name: string): string {\n  return shout(name);\n}\nfunction shout(s: string): string { return s.toUpperCase(); }\n");
    // build output should be excluded from the deps map (mirrors a submodule's build/ tree polluting the graph)
    mkdirSync(join(projectDir, "build"), { recursive: true });
    writeFileSync(join(projectDir, "build", "legacy.js"), "module.exports = function legacyThing() {};\n");

    const result = await new ExportCommand().run({ dir: projectDir, force: true });
    const exportDir = join(projectDir, ".claude", "skills", "trace");

    assert.equal(result.dest, exportDir);
    assert.ok(existsSync(join(exportDir, "SKILL.md")), "the bundled skill was copied into the export directory");

    const graphMap = result.maps.find((m) => m.kind === "graph");
    const depsMap = result.maps.find((m) => m.kind === "deps");
    assert.ok(graphMap && existsSync(graphMap.path), "graph.html written");
    assert.ok(depsMap && existsSync(depsMap.path), "deps.html written");
    assert.match(readFileSync(graphMap.path, "utf8"), /<!doctype html>/i, "graph.html is a real HTML page");
    const depsHtml = readFileSync(depsMap.path, "utf8");
    assert.match(depsHtml, /<!doctype html>/i, "deps.html is a real HTML page");
    // build/ output is excluded from the deps map (and the graph never scans build/ either)
    assert.ok(!depsHtml.includes("legacy.js"), "build/legacy.js is excluded from the deps map");
    assert.ok(!readFileSync(graphMap.path, "utf8").includes("legacy"), "build/ is not in the repo graph");
    // the repo map should have found our symbol → a non-degraded graph page
    assert.equal(graphMap.ok, true, "the repo map built cleanly over the temp project");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("exports refuses to clobber an existing export directory without --force", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "trace-export-"));
  try {
    mkdirSync(join(projectDir, ".claude", "skills", "trace"), { recursive: true });
    await assert.rejects(() => new ExportCommand().run({ dir: projectDir }), /already exists.*--force/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
