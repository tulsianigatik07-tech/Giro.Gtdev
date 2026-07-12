import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { createApp } from "../app.js";
import { createMetricsMiddleware } from "../middleware/metricsMiddleware.js";
import { rateLimiter } from "../middleware/rateLimiter.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { processNextIndexingJob } from "../services/indexing/jobs/indexingJobWorker.js";

test("public metrics endpoint uses Prometheus content type and valid exposition", async () => {
  const metrics = new MetricsRegistry();
  const app = createApp({ metrics });
  await app.request("/health/live");
  const response = await app.request("/metrics");
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; version=0.0.4");
  assert.match(body, /^# HELP giro_http_requests_total/m);
  assert.match(body, /^# TYPE giro_http_request_duration_seconds histogram$/m);
  assert.match(body, /giro_http_requests_total\{route="\/health\/live",method="GET",status_class="2xx"\} 1/);
  assert.match(body, /giro_http_request_duration_seconds_count\{route="\/health\/live",method="GET"\} 1/);
  assert.match(body, /giro_http_request_duration_seconds_bucket\{route="\/health\/live",method="GET",le="\+Inf"\} 1/);
});

test("repeated requests increment counters and histogram counts", async () => {
  const metrics = new MetricsRegistry({ durationBucketsSeconds: [0.1, 1] });
  const app = createApp({ metrics });
  await app.request("/health/live");
  await app.request("/health/live");
  const output = metrics.render();

  assert.match(output, /status_class="2xx"\} 2/);
  assert.match(output, /_count\{route="\/health\/live",method="GET"\} 2/);
  assert.match(output, /le="0.1"\} [0-2]/);
});

test("in-flight gauge is concurrency safe and returns to zero", async () => {
  const metrics = new MetricsRegistry();
  const app = new Hono();
  app.use("*", createMetricsMiddleware(metrics));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  app.get("/work", async (c) => {
    await blocked;
    return c.text("done");
  });

  const requests = [app.request("/work"), app.request("/work"), app.request("/work")];
  await Promise.resolve();
  assert.match(metrics.render(), /giro_http_requests_in_flight 3/);
  release();
  await Promise.all(requests);
  assert.match(metrics.render(), /giro_http_requests_in_flight 0/);
  assert.match(metrics.render(), /status_class="2xx"\} 3/);
});

test("readiness gauge reflects ready, degraded, failure, and not-ready states", async () => {
  const readyMetrics = new MetricsRegistry();
  const readyApp = createApp({
    metrics: readyMetrics,
    readinessCheck: async () => ({ status: "ready", checks: [] }),
  });
  await readyApp.request("/health/ready");
  assert.match(readyMetrics.render(), /giro_health_readiness 1/);

  const degradedMetrics = new MetricsRegistry();
  const degradedApp = createApp({
    metrics: degradedMetrics,
    readinessCheck: async () => ({ status: "degraded", checks: [] }),
  });
  await degradedApp.request("/health/ready");
  assert.match(degradedMetrics.render(), /giro_health_readiness 1/);

  const unavailableMetrics = new MetricsRegistry();
  const unavailableApp = createApp({
    metrics: unavailableMetrics,
    readinessCheck: async () => ({ status: "not_ready", checks: [] }),
  });
  await unavailableApp.request("/health/ready");
  assert.match(unavailableMetrics.render(), /giro_health_readiness 0/);
});

test("rate limiter rejection counter increments only on rejected requests", async () => {
  const metrics = new MetricsRegistry();
  const app = new Hono();
  app.use("/limited", rateLimiter({
    windowMs: 60_000,
    maxRequests: 1,
    onRejected: () => metrics.incrementRateLimitRejections(),
  }));
  app.get("/limited", (c) => c.text("ok"));

  await app.request("/limited");
  await app.request("/limited");
  await app.request("/limited");
  assert.match(metrics.render(), /giro_rate_limit_rejections_total 2/);
});

test("indexing lifecycle counter records started, completed, and failed", async () => {
  const metrics = new MetricsRegistry();
  const store = new MemoryIndexingJobStore();
  const repositoryStore = {
    markIndexing: () => undefined,
    markIndexed: () => undefined,
    markFailed: () => undefined,
  };
  const jobInput = {
    repositoryId: "acme/demo",
    ownerUserId: "user-1",
    repositoryOwner: "acme",
    repositoryName: "demo",
    repositoryUrl: "https://github.com/acme/demo",
    branch: "main",
  };
  await store.createJob(jobInput);
  await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    repositoryStore,
    metrics,
    executeIndexingPipeline: async () => ({
      counts: {
        chunkCount: 0,
        fileCount: 0,
        symbolCount: 0,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        summaryAvailable: false,
      },
    }),
  });
  await store.createJob({ ...jobInput, repositoryId: "acme/failing", repositoryName: "failing" });
  await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    repositoryStore,
    metrics,
    executeIndexingPipeline: async () => { throw new Error("failed"); },
  });

  const output = metrics.render();
  assert.match(output, /giro_repository_indexing_total\{status="started"\} 2/);
  assert.match(output, /giro_repository_indexing_total\{status="completed"\} 1/);
  assert.match(output, /giro_repository_indexing_total\{status="failed"\} 1/);
});

test("labels use route templates and never include request data", async () => {
  const metrics = new MetricsRegistry();
  const app = new Hono();
  app.use("*", createMetricsMiddleware(metrics, { monotonicNow: () => 1_000 }));
  app.get("/items/:id", (c) => c.text(c.req.param("id")));
  await app.request("/items/private-repository?query=secret");
  const output = metrics.render();

  assert.match(output, /route="\/items\/:id"/);
  assert.equal(output.includes("private-repository"), false);
  assert.equal(output.includes("secret"), false);
});

test("rejects unsafe histogram bucket configuration", () => {
  assert.throws(() => new MetricsRegistry({ durationBucketsSeconds: [] }));
  assert.throws(() => new MetricsRegistry({ durationBucketsSeconds: [1, 0.5] }));
  assert.throws(() => new MetricsRegistry({ durationBucketsSeconds: [Number.NaN] }));
});
