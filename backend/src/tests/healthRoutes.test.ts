import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../app.js";
import type { ApplicationReadiness } from "../services/health/readinessService.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import {
  createProductionHealthCheck,
  type ProductionHealthCheck,
} from "../services/health/productionHealth.js";

type Envelope = {
  success: boolean;
  data: Record<string, unknown>;
  requestId: string;
};

async function request(
  path: string,
  readinessCheck: () => Promise<ApplicationReadiness>,
  productionHealthCheck: ProductionHealthCheck = createProductionHealthCheck({
    checkSupabase: () => undefined,
    checkIndexingWorker: () => undefined,
  }),
) {
  const app = createApp({
    indexingJobStore,
    readinessCheck,
    productionHealthCheck,
    healthClock: {
      uptime: () => 42.9,
      now: () => new Date("2026-07-20T12:00:00.000Z"),
    },
  });
  const response = await app.request(path);
  return { response, body: (await response.json()) as Envelope };
}

const ready = Object.freeze({
  status: "ready" as const,
  checks: Object.freeze([
    Object.freeze({
      name: "database",
      status: "pass" as const,
      critical: true,
      message: "Database connectivity is available.",
    }),
  ]),
});

test("liveness returns a stable 200 response without invoking readiness dependencies", async () => {
  let dependencyCalls = 0;
  const { response, body } = await request("/health/live", async () => {
    dependencyCalls += 1;
    return ready;
  });

  assert.equal(response.status, 200);
  assert.equal(dependencyCalls, 0);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, { status: "alive", service: "giro-backend" });
  assert.equal(typeof body.requestId, "string");
});

test("readiness returns HTTP 200 for ready and degraded", async () => {
  const readyResponse = await request("/health/ready", async () => ready);
  const degradedResponse = await request("/health/ready", async () => ({
    status: "degraded",
    checks: [{
      name: "optional_metrics",
      status: "fail",
      critical: false,
      message: "Optional metrics are unavailable.",
    }],
  }));

  assert.equal(readyResponse.response.status, 200);
  assert.equal(readyResponse.body.data.status, "ready");
  assert.equal(degradedResponse.response.status, 200);
  assert.equal(degradedResponse.body.data.status, "degraded");
});

test("readiness returns HTTP 503 for not ready", async () => {
  const { response, body } = await request("/health/ready", async () => ({
    status: "not_ready",
    checks: [{
      name: "database",
      status: "fail",
      critical: true,
      message: "Database connectivity is unavailable.",
    }],
  }));

  assert.equal(response.status, 503);
  assert.equal(body.success, true);
  assert.equal(body.data.status, "not_ready");
});

test("unexpected readiness failure returns a safe 503 without leakage", async () => {
  const { response, body } = await request("/health/ready", async () => {
    const error = new Error("sk-secret https://provider.test");
    error.stack = "at /private/runtime.ts:1";
    throw error;
  });
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 503);
  assert.deepEqual(body.data, { status: "not_ready", checks: [] });
  assert.equal(serialized.includes("sk-secret"), false);
  assert.equal(serialized.includes("provider.test"), false);
  assert.equal(serialized.includes("runtime.ts"), false);
});

test("production health returns a deterministic healthy contract", async () => {
  const { response, body } = await request("/health", async () => ready);

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, {
    status: "healthy",
    service: "giro-backend",
    version: "0.1.0",
    uptimeSeconds: 42,
    timestamp: "2026-07-20T12:00:00.000Z",
    checks: {
      api: { status: "healthy", required: true },
      supabase: { status: "healthy", required: true },
      indexingWorker: { status: "healthy", required: false },
    },
  });
});

test("production health is degraded when only the indexing worker is unhealthy", async () => {
  const healthCheck = createProductionHealthCheck({
    checkSupabase: () => undefined,
    checkIndexingWorker: () => { throw new Error("worker unavailable"); },
  });
  const { response, body } = await request("/health", async () => ready, healthCheck);

  assert.equal(response.status, 200);
  assert.equal(body.data.status, "degraded");
  assert.deepEqual((body.data.checks as Record<string, unknown>).indexingWorker, {
    status: "unhealthy",
    required: false,
  });
});

test("production health returns 503 when a required dependency times out", async () => {
  const healthCheck = createProductionHealthCheck({
    checkSupabase: () => new Promise<void>(() => undefined),
    checkIndexingWorker: () => undefined,
  }, 5);
  const { response, body } = await request("/health", async () => ready, healthCheck);

  assert.equal(response.status, 503);
  assert.equal(body.data.status, "unhealthy");
  assert.deepEqual((body.data.checks as Record<string, unknown>).supabase, {
    status: "unhealthy",
    required: true,
  });
});

test("production health failures never expose dependency secrets or diagnostics", async () => {
  const healthCheck = createProductionHealthCheck({
    checkSupabase: () => {
      const error = new Error("sk-secret Bearer token https://db.example.test");
      error.stack = "at /private/service/path.ts:1";
      throw error;
    },
    checkIndexingWorker: () => { throw new Error("worker-token"); },
  });
  const { response, body } = await request("/health", async () => ready, healthCheck);
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 503);
  for (const secret of ["sk-secret", "Bearer token", "db.example.test", "/private/", "worker-token"]) {
    assert.equal(serialized.includes(secret), false);
  }
});
