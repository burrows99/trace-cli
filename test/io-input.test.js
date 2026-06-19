// InputManager tests — the input tier. It accepts a transport-neutral parsed object (NOT argv), throws a
// structured InputError (never process.exit) on bad input, and normalizes the rest into a typed request.
// Pure + synchronous: no engine, no network. Covers the guards, the SECURITY-critical step redaction, and the
// target/args normalization that used to be inlined in Cli.#runDynamic.
import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";

import { InputManager } from "../dist/io/InputManager.js";
import { InputError } from "../dist/io/InputError.js";
import { TargetKind } from "../dist/domain/Target.js";
import { Code } from "../dist/shared/codes.js";

const im = new InputManager();
// Commander always supplies the repeatable arrays; mirror that so a raw input is realistic.
const runRaw = (over = {}) => ({ breakpoint: ["app.js:10"], expression: [], step: [], ...over });
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return undefined; };

test("acceptRun redacts type:/eval: steps in meta.args but keeps them raw for the runner", () => {
  const { request } = im.acceptRun(runRaw({
    chrome: true, url: "http://x",
    step: ["type:#pw=hunter2", "eval:document.cookie", "click:#go"],
  }));
  // The raw steps reach the engine intact (the runner needs the real password/script).
  assert.deepEqual(request.steps, ["goto:http://x", "type:#pw=hunter2", "eval:document.cookie", "click:#go"]);
  // meta.args (which lands in the envelope) is redacted.
  assert.deepEqual(request.args.steps, ["goto:http://x", "type:#pw=***", "eval:***", "click:#go"]);
  const argsJson = JSON.stringify(request.args);
  assert.ok(!argsJson.includes("hunter2"), "a typed password must never leak into meta.args");
  assert.ok(!argsJson.includes("document.cookie"), "an eval body must never leak into meta.args");
});

test("acceptRun maps every guard to an InputError with the exact usage wording (and the INPUT code)", () => {
  const cases = [
    [{ node: true, chrome: true }, "pick one target: --node or --chrome, not both"],
    [{ node: true, chromeProfile: "/p" }, "--chrome-profile is a chrome option — don't combine it with --node"],
    [{ chromeProfile: "/p", chrome: "9222" }, "pick one: --chrome-profile launches a logged-in browser, or --chrome <port> attaches to a running one — not both"],
    [{ headed: true }, "--headed only applies when launching Chrome (use with --chrome or --chrome-profile)"],
    [{ node: true, curl: "c", concise: true, detailed: true }, "pick one envelope verbosity: --concise or --detailed, not both"],
    [{ node: true, curl: "c", breakpoint: [] }, "run needs at least one --breakpoint (file:line or file@substring)"],
    [{ chrome: true }, "chrome target needs --url or at least one --step"],
    [{ chrome: true, url: "http://x", curl: "c" }, "--curl is a node-only trigger (chrome uses --url/--step)"],
    [{ node: true, curl: "c", step: ["click:#x"] }, "--step is a chrome-only trigger (node uses --curl)"],
    [{ node: true }, "node target needs --curl"],
  ];
  for (const [over, message] of cases) {
    const error = thrown(() => im.acceptRun(runRaw(over)));
    assert.ok(error instanceof InputError, `expected InputError for ${message}`);
    assert.equal(error.code, Code.INPUT);
    assert.equal(error.message, message);
  }
});

test("acceptRun rejects an unknown step verb as an invalid-step InputError carrying the problems", () => {
  const error = thrown(() => im.acceptRun(runRaw({ chrome: true, step: ["frobnicate:x"] })));
  assert.ok(error instanceof InputError);
  assert.match(error.message, /^invalid step —/);
  assert.ok(error.problems.length >= 1);
});

test("acceptRun surfaces a DynamicInput violation (out-of-range port) as an invalid-input InputError", () => {
  const error = thrown(() => im.acceptRun(runRaw({ node: "70000", curl: "c" })));
  assert.ok(error instanceof InputError);
  assert.match(error.message, /^invalid input —/);
});

test("acceptRun normalizes the target: node default/explicit, chrome launch/attach, chrome-profile", () => {
  let { request } = im.acceptRun(runRaw({ curl: "c" }));               // node default
  assert.equal(request.target, TargetKind.Node);
  assert.equal(request.port, 9229);
  assert.equal(request.launch, false);

  ({ request } = im.acceptRun(runRaw({ node: "9300", curl: "c" })));   // node explicit port
  assert.equal(request.port, 9300);

  ({ request } = im.acceptRun(runRaw({ chrome: true, url: "http://x" }))); // bare --chrome → launch throwaway
  assert.equal(request.target, TargetKind.Chrome);
  assert.equal(request.launch, true);
  assert.equal(request.port, 0);

  ({ request } = im.acceptRun(runRaw({ chrome: "9222", url: "http://x" }))); // --chrome <port> → attach
  assert.equal(request.launch, false);
  assert.equal(request.port, 9222);

  ({ request } = im.acceptRun(runRaw({ chromeProfile: "/tmp/prof", url: "http://x" }))); // profile → launch+headed
  assert.equal(request.launch, true);
  assert.equal(request.headed, true);
  assert.equal(request.profileDir, "/tmp/prof");
});

test("acceptRun assembles meta.args: node carries the port, a chrome launch carries launch:true + the goto step", () => {
  let { request } = im.acceptRun(runRaw({ node: "9300", curl: "c", root: "/r", maxHits: 5 }));
  assert.deepEqual(request.args, { target: "node", port: 9300, breakpoints: ["app.js:10"], root: "/r", maxHits: 5, curl: "c" });

  ({ request } = im.acceptRun(runRaw({ chrome: true, url: "http://x" })));
  assert.equal(request.args.launch, true);
  assert.equal(request.args.port, undefined);
  assert.deepEqual(request.args.steps, ["goto:http://x"]);
});

test("acceptGraph parses file@symbol and file:line:column entries", () => {
  let request = im.acceptGraph({ entry: "src/a.ts@foo", depth: 6 });
  assert.equal(request.entry.file, "src/a.ts");
  assert.equal(request.entry.symbol, "foo");
  assert.equal(request.maxDepth, 6);

  request = im.acceptGraph({ entry: "src/a.ts:42:9", depth: 4 });
  assert.equal(request.entry.line, 42);
  assert.equal(request.entry.column, 9);
});

test("acceptGraph rejects an entry with neither a line nor a symbol", () => {
  const error = thrown(() => im.acceptGraph({ entry: "src/a.ts", depth: 6 }));
  assert.ok(error instanceof InputError);
  assert.match(error.message, /^invalid input —/);
});

test("acceptDeps requires an entry and assembles args", () => {
  const error = thrown(() => im.acceptDeps({}));
  assert.ok(error instanceof InputError);
  assert.equal(error.message, "deps needs --entry <file|dir>");

  const request = im.acceptDeps({ entry: "src", root: "/r" });
  assert.equal(request.entry, "src");
  assert.deepEqual(request.args, { entry: "src", root: "/r" });
});

test("acceptComplexity defaults the path to '.'", () => {
  assert.equal(im.acceptComplexity({}).path, ".");
  assert.equal(im.acceptComplexity({ path: "src" }).path, "src");
});

test("acceptSymbols requires a file", () => {
  const error = thrown(() => im.acceptSymbols({}));
  assert.ok(error instanceof InputError);
  assert.equal(error.message, "symbols needs a <file>");
  assert.equal(im.acceptSymbols({ file: "a.ts" }).file, "a.ts");
});
