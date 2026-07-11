import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createShutdownCoordinator,
  type ShutdownLogger,
} from "../runtime/shutdownCoordinator.js";

function recordingLogger() {
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const record = (event: string, fields?: Record<string, unknown>) => {
    events.push({ event, fields });
  };
  const logger: ShutdownLogger = { info: record, warn: record, error: record };
  return { logger, events };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("first signal starts shutdown and clean tasks run in deterministic order", async () => {
  const order: string[] = [];
  const { logger, events } = recordingLogger();
  const coordinator = createShutdownCoordinator({
    logger,
    timeoutMs: 10_000,
    stopAcceptingRequests: () => { order.push("stop"); },
    cleanupTasks: [
      { name: "first", run: () => { order.push("first"); } },
      { name: "second", run: () => { order.push("second"); } },
    ],
  });

  const result = await coordinator.requestShutdown("SIGTERM");

  assert.deepEqual(order, ["stop", "first", "second"]);
  assert.deepEqual(result, { signal: "SIGTERM", outcome: "completed", exitCode: 0 });
  assert.equal(coordinator.isShuttingDown(), true);
  assert.equal(coordinator.getShutdownState().phase, "completed");
  assert.equal(events.filter((item) => item.event === "shutdown_started").length, 1);
});

test("cleanup failure does not prevent later tasks and returns exit code one", async () => {
  const order: string[] = [];
  const { logger, events } = recordingLogger();
  const coordinator = createShutdownCoordinator({
    logger,
    timeoutMs: 10_000,
    cleanupTasks: [
      { name: "fails", run: () => { throw new Error("sk-secret stack"); } },
      { name: "continues", run: () => { order.push("continues"); } },
    ],
  });

  const result = await coordinator.requestShutdown("SIGINT");
  const serialized = JSON.stringify(events);

  assert.deepEqual(order, ["continues"]);
  assert.equal(result.outcome, "failed");
  assert.equal(result.exitCode, 1);
  assert.equal(serialized.includes("sk-secret"), false);
  assert.equal(serialized.includes("stack"), false);
});

test("duplicate signal forces shutdown without running cleanup twice", async () => {
  const active = deferred();
  let stopCalls = 0;
  let cleanupCalls = 0;
  let forceCalls = 0;
  const { logger } = recordingLogger();
  const coordinator = createShutdownCoordinator({
    logger,
    timeoutMs: 10_000,
    stopAcceptingRequests: () => { stopCalls += 1; },
    cleanupTasks: [{
      name: "active",
      run: () => {
        cleanupCalls += 1;
        return active.promise;
      },
    }],
    forceStop: () => { forceCalls += 1; },
  });

  const first = coordinator.requestShutdown("SIGTERM");
  await Promise.resolve();
  const second = coordinator.requestShutdown("SIGINT");
  const result = await second;

  assert.equal(first, second);
  assert.deepEqual(result, { signal: "SIGTERM", outcome: "forced", exitCode: 1 });
  assert.equal(stopCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(forceCalls, 1);
  active.resolve();
});

test("timeout forces shutdown with deterministic result", async () => {
  const active = deferred();
  let timeoutCallback: (() => void) | undefined;
  let forceCalls = 0;
  const { logger, events } = recordingLogger();
  const coordinator = createShutdownCoordinator({
    logger,
    timeoutMs: 5_000,
    cleanupTasks: [{ name: "active", run: () => active.promise }],
    forceStop: () => { forceCalls += 1; },
    setTimer: (callback) => {
      timeoutCallback = callback;
      return 1;
    },
    clearTimer: () => undefined,
  });

  const resultPromise = coordinator.requestShutdown("SIGTERM");
  timeoutCallback?.();
  const result = await resultPromise;

  assert.deepEqual(result, { signal: "SIGTERM", outcome: "timeout", exitCode: 1 });
  assert.equal(forceCalls, 1);
  assert.equal(events.some((item) => item.event === "shutdown_timeout"), true);
  active.resolve();
});

test("reusable coordinator never calls process.exit", async () => {
  const originalExit = process.exit;
  let exitCalls = 0;
  process.exit = ((() => { exitCalls += 1; }) as unknown) as typeof process.exit;
  try {
    const { logger } = recordingLogger();
    const coordinator = createShutdownCoordinator({ logger, timeoutMs: 1_000 });
    await coordinator.requestShutdown("SIGINT");
    assert.equal(exitCalls, 0);
  } finally {
    process.exit = originalExit;
  }
});
