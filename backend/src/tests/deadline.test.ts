import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeadline, DeadlineExceededError, waitForDeadline } from "../runtime/deadline.js";

function fakeTime() {
  let now = 1_000;
  let callback: (() => void) | undefined;
  let clears = 0;
  return {
    options: {
      now: () => now,
      setTimer: (next: () => void) => { callback = next; return 1; },
      clearTimer: () => { clears += 1; },
    },
    advance(ms: number) { now += ms; },
    expire() { callback?.(); },
    clears: () => clears,
  };
}

test("deadline reports remaining time and does not expire early", () => {
  const time = fakeTime();
  const deadline = createDeadline(1_000, time.options);
  assert.equal(deadline.remainingMs(), 1_000);
  time.advance(400);
  assert.equal(deadline.remainingMs(), 600);
  assert.doesNotThrow(() => deadline.throwIfExpired());
});

test("deadline expires with a normalized reason", () => {
  const time = fakeTime();
  const deadline = createDeadline(1_000, time.options);
  time.advance(1_000);
  assert.throws(() => deadline.throwIfExpired(), DeadlineExceededError);
  assert.equal(deadline.signal.aborted, true);
});

test("timer expiry rejects a safely observed operation", async () => {
  const time = fakeTime();
  const deadline = createDeadline(1_000, time.options);
  const pending = waitForDeadline(new Promise<string>(() => undefined), deadline);
  time.expire();
  await assert.rejects(pending, DeadlineExceededError);
});

test("dispose clears the timer once and is repeatable", () => {
  const time = fakeTime();
  const deadline = createDeadline(1_000, time.options);
  deadline.dispose();
  deadline.dispose();
  assert.equal(time.clears(), 1);
  time.expire();
  assert.equal(deadline.signal.aborted, false);
});

test("parent signal propagates without being misreported as deadline expiry", () => {
  const parent = new AbortController();
  const time = fakeTime();
  const deadline = createDeadline(1_000, { ...time.options, parentSignal: parent.signal });
  const reason = new Error("shutdown");
  parent.abort(reason);
  assert.equal(deadline.signal.aborted, true);
  assert.equal(deadline.signal.reason, reason);
  assert.throws(() => deadline.throwIfExpired(), reason);
});
