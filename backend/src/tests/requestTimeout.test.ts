import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createApp } from "../app.js";
import { createRequestContextMiddleware } from "../middleware/requestContext.js";
import { createRequestTimeoutMiddleware } from "../middleware/requestTimeout.js";
import { MetricsRegistry } from "../observability/metrics.js";

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
  assert.equal(fixture.logs[0]?.fields?.durationMs, 1_000);
  fixture.release();
  await Promise.resolve();
  assert.equal(fixture.clears(), 1);
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

test("health and metrics routes remain outside request deadline middleware", async () => {
  const metrics = new MetricsRegistry();
  const app = createApp({ metrics, readinessCheck: async () => ({ status: "ready", checks: [] }) });
  assert.equal((await app.request("/health/live")).status, 200);
  assert.equal((await app.request("/health/ready")).status, 200);
  assert.equal((await app.request("/metrics")).status, 200);
  assert.match(metrics.render(), /giro_timeouts_total\{category="request"\} 0/);
});
