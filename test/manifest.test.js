// Manifest tests: the self-describing CLI contract is GENERATED from the parser, so it must stay in
// sync with the command tree and be deterministic. Run via `npm test` (builds first).
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";

import { Cli } from "../dist/cli/Cli.js";
import { ManifestCommand } from "../dist/cli/commands/ManifestCommand.js";

const manifest = () => new ManifestCommand().run(new Cli().build());

test("manifest describes the tool and the whole command tree", () => {
  const m = manifest();
  assert.equal(m.tool, "trace");
  assert.match(m.version, /^\d+\.\d+\.\d+/);
  assert.equal(m.command.name, "trace-cli");
  const names = m.command.commands.map((c) => c.name).sort();
  // Generated from the parser — every registered subcommand appears, including manifest itself.
  assert.deepEqual(names, ["doctor", "dynamic", "export-skill", "manifest", "schema", "serve"]);
});

test("manifest captures option metadata: flags, defaults, negate", () => {
  const dyn = manifest().command.commands.find((c) => c.name === "dynamic");
  const bp = dyn.options.find((o) => o.flags.startsWith("--bp"));
  assert.ok(bp, "--bp option present");
  assert.equal(dyn.options.find((o) => o.flags.includes("max-hits")).default, 25);
  assert.equal(dyn.options.find((o) => o.flags.includes("no-record")).negate, true);
});

test("manifest is deterministic — byte-identical across runs", () => {
  assert.equal(JSON.stringify(manifest()), JSON.stringify(manifest()));
});
