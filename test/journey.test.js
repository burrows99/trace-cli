// JourneyRunner.parseStep — the pure `--step` parser DynamicCommand feeds the Chrome journey. The runner's
// CDP driving needs a live Chrome (not exercised here); this pins the parsing contract. Run via `npm test`.
import "reflect-metadata"; // StepResult uses class-validator decorators (the domain loads this via Trace.ts)
import { test } from "node:test";
import assert from "node:assert/strict";

import { JourneyRunner } from "../dist/engine/JourneyRunner.js";

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
