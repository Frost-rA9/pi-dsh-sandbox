/**
 * The dialog queue that spaces concurrent escalation approvals.
 *
 * pi's interactive UI holds one extension-dialog slot and does not settle a
 * dialog it replaces, so the queue is what keeps a second approval from
 * silently dropping the first. These tests drive it with controlled openers,
 * no pi and no terminal.
 *
 * @module pi-dsh-sandbox/tests/dialog-queue
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DialogQueue } from "../src/dialog-queue.ts";

/** Yield until the queue's microtask hand-off has run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A promise the test resolves by hand. */
function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("opens one dialog at a time and hands each caller its own answer", async () => {
  const queue = new DialogQueue();
  const gates = [gate<string>(), gate<string>(), gate<string>()];
  let openDialogs = 0;
  let peak = 0;

  const runs = gates.map((held) => queue.run(async () => {
    openDialogs += 1;
    peak = Math.max(peak, openDialogs);
    try {
      return await held.promise;
    } finally {
      openDialogs -= 1;
    }
  }));

  await settle();
  assert.equal(peak, 1, "a second dialog must not open while one is up");
  assert.equal(openDialogs, 1);
  assert.equal(queue.pending, 2, "the rest wait in the queue");

  gates[0].open("first");
  await settle();
  assert.equal(queue.pending, 1, "the slot moved to the next waiter");

  gates[1].open("second");
  gates[2].open("third");
  assert.deepEqual(await Promise.all(runs), ["first", "second", "third"]);
  assert.equal(queue.pending, 0);
});

test("serves queued requests in arrival order", async () => {
  const queue = new DialogQueue();
  const first = gate<void>();
  const opened: string[] = [];

  const running = queue.run(async () => {
    await first.promise;
    return "released";
  });
  const waiting = ["a", "b", "c"].map((label) => queue.run(async () => {
    opened.push(label);
    return label;
  }));

  await settle();
  assert.deepEqual(opened, [], "nothing opens behind the held dialog");
  first.open();
  await running;
  assert.deepEqual(await Promise.all(waiting), ["a", "b", "c"]);
  assert.deepEqual(opened, ["a", "b", "c"]);
});

test("aborting while queued withdraws the request and leaves the queue usable", async () => {
  const queue = new DialogQueue();
  const held = gate<void>();
  const controller = new AbortController();

  const running = queue.run(async () => {
    await held.promise;
    return "held";
  });
  const aborted = queue.run(async () => "never opened", controller.signal);
  const survivor = queue.run(async () => "survivor");

  await settle();
  assert.equal(queue.pending, 2);
  controller.abort();
  assert.equal(await aborted, undefined, "a queued request aborts to cancelled");
  assert.equal(queue.pending, 1, "the aborted waiter left the queue");

  held.open();
  await running;
  assert.equal(await survivor, "survivor");
});

test("an already-aborted signal never opens a dialog", async () => {
  const queue = new DialogQueue();
  let opened = false;
  const result = await queue.run(async () => {
    opened = true;
    return "answer";
  }, AbortSignal.abort());

  assert.equal(result, undefined);
  assert.equal(opened, false);
  assert.equal(queue.pending, 0);
});

test("a throwing opener releases the slot", async () => {
  const queue = new DialogQueue();
  const held = gate<void>();

  const failing = queue.run(async () => {
    await held.promise;
    throw new Error("dialog failed");
  });
  const next = queue.run(async () => "next");

  await settle();
  held.open();
  await assert.rejects(failing, /dialog failed/);
  assert.equal(await next, "next");
  assert.equal(queue.pending, 0);
});
