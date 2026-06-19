// JourneyRunner.parseStep — the pure `--step` parser RunCommand feeds the Chrome journey. The runner's
// CDP driving needs a live Chrome (not exercised here); this pins the parsing contract. Run via `npm test`.
import "reflect-metadata"; // StepResult uses class-validator decorators (the domain loads this via Trace.ts)
import { test } from "node:test";
import assert from "node:assert/strict";

import { JourneyRunner } from "../dist/engine/JourneyRunner.js";
import { validateSteps } from "../dist/cli/CommandInputs.js";
import { STEP_ACTIONS } from "../dist/engine/JourneyStep.js";

test("parseStep: bare action, action:arg, and type:<sel>=<text>", () => {
  assert.deepEqual(JourneyRunner.parseStep("newtab"), { action: "newtab" });
  assert.deepEqual(JourneyRunner.parseStep("wait:1500"), { action: "wait", arg: "1500" });
  assert.deepEqual(JourneyRunner.parseStep("goto:http://localhost:4000/x"), { action: "goto", arg: "http://localhost:4000/x" });
  assert.deepEqual(JourneyRunner.parseStep("click:text=Impersonate Member"), { action: "click", arg: "text=Impersonate Member" });
});

test("parseStep: type splits on the first '=' so the value can contain '=' (and stays out of the selector)", () => {
  assert.deepEqual(JourneyRunner.parseStep("type:#password=a=b=c"), { action: "type", arg: "#password", value: "a=b=c" });
  assert.deepEqual(JourneyRunner.parseStep("type:#email="), { action: "type", arg: "#email", value: "" });
});

test("validateSteps: the full vocabulary passes (incl. empty type value and bare newtab)", () => {
  assert.deepEqual(
    validateSteps(["goto:http://x/y", "click:text=Go", "type:#email=", "wait:500", "waitfor:#ok", "newtab", "eval:return 1"]),
    [],
  );
  // every action in the canonical set is accepted on its own (arg "1" satisfies both required-arg and wait-is-numeric)
  for (const a of STEP_ACTIONS) assert.deepEqual(validateSteps([`${a}:1`]), [], `action ${a} should be valid`);
});

test("validateSteps: an unknown action is rejected and names the step", () => {
  const errs = validateSteps(["frobnicate:x"]);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /step #1 \(frobnicate\)/);
  assert.match(errs[0], /action/); // the message points at the bad vocabulary
});

test("validateSteps: a required arg that's missing is rejected", () => {
  assert.match(validateSteps(["click"])[0], /step #1 \(click\).*should not be empty/);
  assert.match(validateSteps(["goto"])[0], /step #1 \(goto\)/);
  assert.equal(validateSteps(["newtab"]).length, 0); // newtab needs no arg
});

test("validateSteps: wait arg must be integer milliseconds", () => {
  assert.equal(validateSteps(["wait:1500"]).length, 0);
  assert.match(validateSteps(["wait:soon"])[0], /milliseconds/);
});

test("validateSteps: error never echoes a typed value (no credential leak)", () => {
  // a malformed type step (no selector) must report the problem without surfacing the secret value
  const errs = validateSteps(["type:=hunter2"]);
  assert.equal(errs.length, 1);
  assert.ok(!errs[0].includes("hunter2"));
});
