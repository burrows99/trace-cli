// Deadline tests: the debugger attach/connect paths must never hang forever. withDeadline is the primitive
// that turns a silent stall (target accepts the socket but never speaks the protocol) into a fast, named
// failure. Run via `npm test` (builds first).
import { test } from "node:test";
import assert from "node:assert/strict";

import { withDeadline, DeadlineError } from "../dist/shared/deadline.js";

const never = () => new Promise(() => {});
const after = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test("resolves with the value when the promise settles in time", async () => {
  assert.equal(await withDeadline(after(5, 42), 100, () => "nope"), 42);
});

test("rejects with a DeadlineError carrying the lazy hint when it stalls", async () => {
  await assert.rejects(
    withDeadline(never(), 20, () => "attach stalled — listener slot held"),
    (e) => e instanceof DeadlineError && /listener slot held/.test(e.message),
  );
});

test("propagates the underlying rejection unchanged (not a DeadlineError)", async () => {
  const boom = new Error("connection refused");
  await assert.rejects(
    withDeadline(Promise.reject(boom), 100, () => "should not be used"),
    (e) => e === boom,
  );
});

test("a late rejection after the deadline does not escape as unhandled", async () => {
  // The promise rejects well after the deadline already fired; withDeadline attaches its handlers
  // synchronously, so that late rejection is already handled and must not surface as unhandledRejection.
  let leaked = null;
  const onLeak = (e) => { leaked = e; };
  process.on("unhandledRejection", onLeak);
  const lateReject = new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 15));
  await assert.rejects(withDeadline(lateReject, 5, () => "deadline"), DeadlineError);
  await after(40); // let the late rejection fire while withDeadline's handler is still attached
  process.removeListener("unhandledRejection", onLeak);
  assert.equal(leaked, null, "a late rejection leaked as unhandledRejection");
});
