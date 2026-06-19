// Manifest tests: the self-describing CLI contract is GENERATED from the parser, so it must stay in
// sync with the command tree and be deterministic. Run via `npm test` (builds first).
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { Cli } from "../dist/cli/Cli.js";
import { ManifestCommand } from "../dist/cli/commands/ManifestCommand.js";

const manifest = () => new ManifestCommand().run(new Cli().build());

test("manifest describes the tool and the whole command tree", () => {
  const m = manifest();
  assert.equal(m.tool, "trace");
  assert.match(m.version, /^\d+\.\d+\.\d+/);
  assert.equal(m.command.name, "trace-cli");
  const names = m.command.commands.map((c) => c.name).sort();
  // Generated from the parser — every registered subcommand appears, including manifest itself. The four
  // static analyses (graph/deps/complexity/symbols) sit at the top level alongside the runtime `run` command.
  assert.deepEqual(names, ["complexity", "deps", "doctor", "exports", "graph", "manifest", "run", "schema", "serve", "symbols"]);
});

test("manifest captures option metadata: flags, defaults, optional, negate", () => {
  const dyn = manifest().command.commands.find((c) => c.name === "run");
  const bp = dyn.options.find((o) => o.flags.startsWith("--breakpoint"));
  assert.ok(bp, "--breakpoint option present");
  assert.deepEqual(bp.default, []); // repeatable collect accumulator defaults to []
  assert.equal(dyn.options.find((o) => o.flags.startsWith("--node")).optional, true); // --node [port]
  // negate extraction: the trimmed CLI has no --no-* flag, so verify the generator against a synthetic one.
  const synthetic = new ManifestCommand().run(new Command().name("x").option("--no-color", "disable color"));
  assert.equal(synthetic.command.options.find((o) => o.flags.includes("no-color")).negate, true);
});

test("manifest is deterministic — byte-identical across runs", () => {
  assert.equal(JSON.stringify(manifest()), JSON.stringify(manifest()));
});
