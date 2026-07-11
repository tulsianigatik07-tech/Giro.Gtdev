import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerType } from "@hono/node-server";
import { createApp } from "../app.js";
import {
  forceCloseHttpServer,
  stopHttpServer,
} from "../runtime/httpServerShutdown.js";
import { runOneShotWorkerRuntime } from "../runtime/oneShotWorkerRuntime.js";
import type { ShutdownLogger, ShutdownSignal } from "../runtime/shutdownCoordinator.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";

const silentLogger: ShutdownLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function signalHarness() {
  const handlers = new Map<ShutdownSignal, () => void>();
  return {
    subscribe(signal: ShutdownSignal, handler: () => void) {
      handlers.set(signal, handler);
      return () => handlers.delete(signal);
    },
    send(signal: ShutdownSignal) {
      handlers.get(signal)?.();
    },
  };
}

test("HTTP server close stops accepts and waits for its completion callback", async () => {
  let closeCalls = 0;
  let closeCallback: ((error?: Error) => void) | undefined;
  let forceCalls = 0;
  const server = {
    close(callback: (error?: Error) => void) {
      closeCalls += 1;
      closeCallback = callback;
    },
    closeAllConnections() {
      forceCalls += 1;
    },
  } as unknown as ServerType;

  let completed = false;
  const closing = stopHttpServer(server).then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(closeCalls, 1);
  assert.equal(completed, false);

  closeCallback?.();
  await closing;
  forceCloseHttpServer(server);
  assert.equal(completed, true);
  assert.equal(forceCalls, 1);
});

test("readiness is not ready while shutdown state is active and liveness remains alive", async () => {
  const app = createApp({
    indexingJobStore,
    isShuttingDown: () => true,
  });

  const readyResponse = await app.request("/health/ready");
  const readyBody = await readyResponse.json() as {
    data: { status: string; checks: Array<{ message: string }> };
  };
  const liveResponse = await app.request("/health/live");
  const liveBody = await liveResponse.json() as { data: { status: string } };

  assert.equal(readyResponse.status, 503);
  assert.equal(readyBody.data.status, "not_ready");
  assert.equal(readyBody.data.checks[0]?.message, "Application shutdown is in progress.");
  assert.equal(liveResponse.status, 200);
  assert.equal(liveBody.data.status, "alive");
});

test("one-shot worker completes active operation after first signal and writes once", async () => {
  const signals = signalHarness();
  const outputs: string[] = [];
  const exitCodes: number[] = [];
  let finish!: () => void;
  const commandReady = new Promise<void>((resolve) => { finish = resolve; });

  const runtime = runOneShotWorkerRuntime({
    timeoutMs: 10_000,
    logger: silentLogger,
    runCommand: async (writeOutput) => {
      await commandReady;
      writeOutput('{"status":"succeeded"}');
      return { status: "succeeded" as const };
    },
    writeOutput: (output) => outputs.push(output),
    interruptedOutput: '{"status":"failed"}',
    subscribeToSignal: signals.subscribe,
    setExitCode: (code) => exitCodes.push(code),
    forceExit: () => assert.fail("clean shutdown must not force exit"),
  });

  signals.send("SIGTERM");
  finish();
  const result = await runtime;

  assert.equal(result?.status, "succeeded");
  assert.deepEqual(outputs, ['{"status":"succeeded"}']);
  assert.deepEqual(exitCodes, [0]);
});

test("second worker signal forces exit without a false success or duplicate output", async () => {
  const signals = signalHarness();
  const outputs: string[] = [];
  const exitCodes: number[] = [];
  const forceCodes: number[] = [];

  const runtime = runOneShotWorkerRuntime({
    timeoutMs: 10_000,
    logger: silentLogger,
    runCommand: () => new Promise<{ status: "succeeded" }>(() => undefined),
    writeOutput: (output) => outputs.push(output),
    interruptedOutput: '{"status":"failed","failure":{"message":"Shutdown forced."}}',
    subscribeToSignal: signals.subscribe,
    setExitCode: (code) => exitCodes.push(code),
    forceExit: (code) => forceCodes.push(code),
  });

  signals.send("SIGINT");
  signals.send("SIGTERM");
  const result = await runtime;

  assert.equal(result, null);
  assert.deepEqual(outputs, [
    '{"status":"failed","failure":{"message":"Shutdown forced."}}',
  ]);
  assert.deepEqual(exitCodes, [1]);
  assert.deepEqual(forceCodes, [1]);
  assert.equal(outputs.join("").includes("succeeded"), false);
});

test("normal worker failure maps to exit code one with one output", async () => {
  const signals = signalHarness();
  const outputs: string[] = [];
  const exitCodes: number[] = [];
  const result = await runOneShotWorkerRuntime({
    timeoutMs: 10_000,
    logger: silentLogger,
    runCommand: async (writeOutput) => {
      writeOutput('{"status":"failed"}');
      return { status: "failed" as const };
    },
    writeOutput: (output) => outputs.push(output),
    interruptedOutput: '{"status":"failed"}',
    subscribeToSignal: signals.subscribe,
    setExitCode: (code) => exitCodes.push(code),
    forceExit: () => assert.fail("normal failure must not force exit"),
  });

  assert.equal(result?.status, "failed");
  assert.deepEqual(outputs, ['{"status":"failed"}']);
  assert.deepEqual(exitCodes, [1]);
});
