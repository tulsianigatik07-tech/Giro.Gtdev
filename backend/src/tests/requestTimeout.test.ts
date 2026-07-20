import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createApp } from "../app.js";
import { createRequestContextMiddleware } from "../middleware/requestContext.js";
import {
  createRequestTimeoutMiddleware,
  getRequestDeadline,
} from "../middleware/requestTimeout.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { createProductionHealthCheck } from "../services/health/productionHealth.js";
import { createProductionReadinessCheck } from "../services/health/productionReadiness.js";

function timeoutApp() {
  const callbacks: Array<() => void> = [];
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  let clears = 0;
  let timeoutCount = 0;
  let now = 1_000;
  const app = new Hono();
  app.use("*", createRequestContextMiddleware({
    generateRequestId: () => "timeout-request-id",
    logger: { info: () => undefined, error: () => undefined },
  }));
  app.use("/slow", createRequestTimeoutMiddleware({
    timeoutMs: 1_000,
    setTimer: (callback) => { callbacks.push(callback); return callbacks.length; },
    clearTimer: () => { clears += 1; },
    now: () => now,
    logger: { error: (event, fields) => logs.push({ event, fields }) },
    onTimeout: () => { timeoutCount += 1; },
  }));
  let release!: () => void;
  app.get("/slow", async (c) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return c.json({ success: true });
  });
  app.get("/fast", (c) => c.json({ success: true }));
  return {
    app,
    callbacks,
    logs,
    clears: () => clears,
    timeoutCount: () => timeoutCount,
    advance: (ms: number) => { now += ms; },
    release: () => release(),
  };
}

test("route under timeout preserves its successful contract", async () => {
  const app = new Hono();
  let cleared = 0;
  app.use("/fast", createRequestTimeoutMiddleware({
    timeoutMs: 1_000,
    setTimer: () => 1,
    clearTimer: () => { cleared += 1; },
  }));
  app.get("/fast", (c) => c.json({ success: true }));
  const response = await app.request("/fast");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.equal(cleared, 1);
});

test("route exceeding timeout returns safe 504 with request ID and one log", async () => {
  const fixture = timeoutApp();
  const responsePromise = fixture.app.request("/slow");
  await Promise.resolve();
  fixture.advance(1_000);
  fixture.callbacks[0]?.();
  const response = await responsePromise;
  const body = await response.json() as { error: { code: string; message: string }; requestId: string };

  assert.equal(response.status, 504);
  assert.equal(response.headers.get("X-Request-ID"), "timeout-request-id");
  assert.equal(body.requestId, "timeout-request-id");
  assert.equal(body.error.code, "request_timeout");
  assert.equal(body.error.message, "The request could not be completed within the allowed time.");
  assert.equal(fixture.logs.length, 1);
  assert.equal(fixture.timeoutCount(), 1);
  assert.equal(fixture.logs[0]?.event, "request_timeout");
  assert.deepEqual(Object.keys(fixture.logs[0]?.fields ?? {}).sort(), ["durationMs", "method", "requestId", "route"]);
  assert.equal(fixture.logs[0]?.fields?.requestId, "timeout-request-id");
  assert.equal(fixture.logs[0]?.fields?.durationMs, 1_000);
  assert.equal(fixture.clears(), 1);
  fixture.release();
  await Promise.resolve();
  assert.equal(fixture.clears(), 1);
});

test("late handler completion cannot replace or duplicate the timeout response", async () => {
  const fixture = timeoutApp();
  let responseCompletions = 0;
  const responsePromise = Promise.resolve(fixture.app.request("/slow")).then((response) => {
    responseCompletions += 1;
    return response;
  });
  await Promise.resolve();
  fixture.callbacks[0]?.();
  const response = await responsePromise;
  const bodyBeforeLateCompletion = await response.clone().text();

  fixture.release();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(responseCompletions, 1);
  assert.equal(response.status, 504);
  assert.equal(await response.text(), bodyBeforeLateCompletion);
});

test("concurrent requests own isolated deadlines", async () => {
  const fixture = timeoutApp();
  const first = fixture.app.request("/slow");
  const second = fixture.app.request("/slow");
  await Promise.resolve();
  assert.equal(fixture.callbacks.length, 2);
  fixture.callbacks[0]?.();
  assert.equal((await first).status, 504);
  fixture.callbacks[1]?.();
  assert.equal((await second).status, 504);
  fixture.release();
});

test("REQUEST_TIMEOUT_MS can be overridden through application composition", async () => {
  const scheduledDelays: number[] = [];
  let cleared = 0;
  const app = createApp({
    requestTimeout: {
      timeoutMs: 4_321,
      setTimer: (_callback, delay) => {
        scheduledDelays.push(delay);
        return 1;
      },
      clearTimer: () => { cleared += 1; },
    },
  });

  assert.equal((await app.request("/")).status, 200);
  assert.deepEqual(scheduledDelays, [4_321]);
  assert.equal(cleared, 1);
});

test("invalid or unsafe timeout overrides are rejected during app creation", () => {
  for (const timeoutMs of [0, 999, 120_001, 1_000.5, Number.NaN]) {
    assert.throws(
      () => createApp({ requestTimeout: { timeoutMs } }),
      /Request timeout must be an integer between 1000 and 120000 milliseconds/,
    );
  }
});

test("health and readiness routes remain outside centralized request timeout handling", async () => {
  const metrics = new MetricsRegistry();
  let timersCreated = 0;
  const app = createApp({
    metrics,
    readinessCheck: async () => ({ status: "ready", checks: [] }),
    productionHealthCheck: createProductionHealthCheck({
      checkSupabase: () => undefined,
      checkIndexingWorker: () => undefined,
    }),
    productionReadinessCheck: createProductionReadinessCheck({
      isStartupComplete: () => true,
      checkSupabase: () => undefined,
      checkEnvironment: () => undefined,
      checkStorage: () => undefined,
      isShuttingDown: () => false,
      workerEnabled: false,
      checkIndexingWorker: () => undefined,
    }),
    requestTimeout: {
      setTimer: () => { timersCreated += 1; return timersCreated; },
      clearTimer: () => undefined,
    },
  });
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/health/live")).status, 200);
  assert.equal((await app.request("/health/ready")).status, 200);
  assert.equal((await app.request("/ready")).status, 200);
  assert.equal(timersCreated, 0);
  assert.match(metrics.render(), /giro_timeouts_total\{category="request"\} 0/);
});

test("request deadline AbortSignal is propagated to handlers that consume it", async () => {
  const callbacks: Array<() => void> = [];
  let observedSignal: AbortSignal | undefined;
  let abortEvents = 0;
  const app = new Hono();
  app.use("*", createRequestContextMiddleware({
    generateRequestId: () => "abort-propagation-id",
    logger: { info: () => undefined, error: () => undefined },
  }));
  app.use("/abort-aware", createRequestTimeoutMiddleware({
    timeoutMs: 1_000,
    setTimer: (callback) => { callbacks.push(callback); return callbacks.length; },
    clearTimer: () => undefined,
    logger: { error: () => undefined },
  }));
  app.get("/abort-aware", async (c) => {
    observedSignal = getRequestDeadline(c)?.signal;
    await new Promise<void>((resolve) => {
      observedSignal?.addEventListener("abort", () => {
        abortEvents += 1;
        resolve();
      }, { once: true });
    });
    return c.json({ success: true });
  });

  const responsePromise = app.request("/abort-aware");
  while (!observedSignal) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  callbacks[0]?.();
  const response = await responsePromise;

  assert.equal(response.status, 504);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(abortEvents, 1);
});
