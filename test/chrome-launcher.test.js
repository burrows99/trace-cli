// ChromeLauncher: the shared headless-Chrome lifecycle used by the `--chrome` launch mode and the recorder.
// Integration test — spawns a real Chrome; skips where none is installed. Run via `npm test` (builds first).
import { test } from "node:test";
import assert from "node:assert/strict";

import { ChromeLauncher, chromeBinary } from "../dist/engine/ChromeLauncher.js";

test("ChromeLauncher spawns a headless Chrome on a free port and tears it down", async (t) => {
  if (!chromeBinary()) { t.skip("no Chrome binary (set CHROME_BIN)"); return; }
  const chrome = await ChromeLauncher.launch();
  try {
    assert.ok(chrome.port > 0, "received a port");
    const version = await (await fetch(`http://localhost:${chrome.port}/json/version`)).json();
    assert.ok(version.Browser, `CDP endpoint answered: ${version.Browser}`);
  } finally {
    chrome.kill();
  }
});

test("two launches get distinct ports (free-port finder, no collision)", async (t) => {
  if (!chromeBinary()) { t.skip("no Chrome binary (set CHROME_BIN)"); return; }
  const a = await ChromeLauncher.launch();
  const b = await ChromeLauncher.launch();
  try {
    assert.notEqual(a.port, b.port, "trace-target and render Chromes must not share a port");
  } finally {
    a.kill();
    b.kill();
  }
});
