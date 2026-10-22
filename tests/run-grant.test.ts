/**
 * The per-run grant that carries a codemode program's approved mode to the
 * calls it makes (`src/run-grant.ts`).
 *
 * The lookup runs on every nested tool call, so the tests pin the two
 * properties the fence depends on: a call belongs to a run only through its
 * `<run id>/…` prefix, and the narrowest enclosing run wins. They also pin
 * the cancellation contract: a mode change aborts the runs admitted under the
 * old mode, and admission waits for their cleanup.
 *
 * @module pi-dsh-sandbox/tests/run-grant
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { awaitCancelledRuns, beginRun, cancelRunsForMode, clearRuns, endRun, markRunDenied, runModeFor, setRunMode } from "../src/run-grant.ts";

beforeEach(() => {
  clearRuns();
});

test("a run covers its nested calls, including the calls those make", () => {
  beginRun("run-1", "danger-full-access");

  assert.equal(runModeFor("run-1"), undefined, "the run's own call keeps the standing policy");
  assert.equal(runModeFor("run-1/1"), "danger-full-access");
  assert.equal(runModeFor("run-1/2"), "danger-full-access");
  assert.equal(runModeFor("run-1/2/3"), "danger-full-access", "a nested tool's own nested call");
});

test("a lookalike id is not a member", () => {
  beginRun("run-1", "danger-full-access");

  assert.equal(runModeFor("run-10/1"), undefined);
  assert.equal(runModeFor("run-"), undefined);
  assert.equal(runModeFor(undefined), undefined);
  assert.equal(runModeFor("write-1"), undefined);
});

test("the narrowest enclosing run wins", () => {
  beginRun("run-1", "workspace-write");
  beginRun("run-1/2", "danger-full-access");

  assert.equal(runModeFor("run-1/1"), "workspace-write");
  assert.equal(runModeFor("run-1/2/1"), "danger-full-access");
});

test("ending a run releases its nested calls", () => {
  beginRun("run-1", "danger-full-access");
  const ended = endRun("run-1");

  assert.deepEqual(ended, { denied: false });
  assert.equal(runModeFor("run-1/1"), undefined);
  assert.equal(endRun("run-1"), undefined);
});

test("a denial is recorded on the owning run only", () => {
  beginRun("run-1", "read-only");
  beginRun("run-2", "read-only");

  markRunDenied("run-1/1");
  markRunDenied("run-3/1");
  markRunDenied(undefined);

  assert.deepEqual(endRun("run-1"), { denied: true });
  assert.deepEqual(endRun("run-2"), { denied: false });
});

test("a mode change cancels the runs admitted under the old mode", () => {
  const stale = beginRun("run-1", "danger-full-access", "workspace-write");
  const current = beginRun("run-2", "read-only", "read-only");

  assert.equal(stale.aborted, false);
  assert.equal(cancelRunsForMode("read-only"), 1);
  assert.equal(stale.aborted, true);
  assert.equal(current.aborted, false, "a run admitted under the new mode keeps running");
  assert.equal(runModeFor("run-1/1"), "danger-full-access", "a cancelled run keeps its grant while it unwinds");
});

test("a grant replaces the admission mode", () => {
  beginRun("run-1", "workspace-write", "workspace-write");
  setRunMode("run-1", "danger-full-access");

  assert.equal(runModeFor("run-1/1"), "danger-full-access");
});

test("a run is cancelled once", () => {
  beginRun("run-1", "danger-full-access", "workspace-write");

  assert.equal(cancelRunsForMode("read-only"), 1);
  assert.equal(cancelRunsForMode("read-only"), 0);
});

test("admission waits for a cancelled run to finish its cleanup", async () => {
  beginRun("run-1", "danger-full-access", "workspace-write");
  cancelRunsForMode("read-only");

  let admitted = false;
  const admission = awaitCancelledRuns().then(() => { admitted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(admitted, false);

  endRun("run-1");
  await admission;
  assert.equal(admitted, true);
});

test("clearing runs releases an admission wait", async () => {
  beginRun("run-1", "danger-full-access", "workspace-write");
  cancelRunsForMode("read-only");

  const admission = awaitCancelledRuns();
  clearRuns();
  await admission;
});
