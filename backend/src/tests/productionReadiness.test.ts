import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../app.js";
import {
  createProductionReadinessCheck,
  type ProductionReadinessCheck,
  type ProductionReadinessDependencies,
} from "../services/health/productionReadiness.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";

type Envelope = {
  success: boolean;
  data: {
    status: string;
    service: string;
    version: string;
    timestamp: string;
    checks: Record<string, { status: string; required: boolean }>;
  };
  requestId: string;
};

function dependencies(
  overrides: Partial<ProductionReadinessDependencies> = {},
): ProductionReadinessDependencies {
  return {
    isStartupComplete: () => true,
    checkSupabase: () => undefined,
    checkEnvironment: () => undefined,
    checkStorage: () => undefined,
    isShuttingDown: () => false,
    workerEnabled: true,
    checkIndexingWorker: () => undefined,
    ...overrides,
  };
}

async function request(check: ProductionReadinessCheck) {
  const app = createApp({
    indexingJobStore,
    productionReadinessCheck: check,
    healthClock: { now: () => new Date("2026-07-21T10:00:00.000Z") },
  });
  const response = await app.request("/ready");
  return { response, body: (await response.json()) as Envelope };
}

test("production readiness returns the deterministic ready contract and HTTP 200", async () => {
  const { response, body } = await request(
    createProductionReadinessCheck(dependencies()),
  );

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(typeof body.requestId, "string");
  assert.deepEqual(body.data, {
    status: "ready",
    service: "giro-backend",
    version: "0.1.0",
    timestamp: "2026-07-21T10:00:00.000Z",
    checks: {
      startup: { status: "pass", required: true },
      supabase: { status: "pass", required: true },
      environment: { status: "pass", required: true },
      storage: { status: "pass", required: true },
      shutdown: { status: "pass", required: true },
      indexingWorker: { status: "pass", required: true },
    },
  });
});

test("production readiness is public and does not require authentication", async () => {
  const { response } = await request(
    createProductionReadinessCheck(dependencies()),
  );
  assert.equal(response.status, 200);
});

test("production readiness returns HTTP 503 when startup is incomplete", async () => {
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({ isStartupComplete: () => false }),
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(body.data.checks.startup, { status: "fail", required: true });
});

test("production readiness returns HTTP 503 when Supabase is unavailable", async () => {
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({ checkSupabase: () => { throw new Error("unavailable"); } }),
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(body.data.checks.supabase, { status: "fail", required: true });
});

test("production readiness returns HTTP 503 when the environment is invalid", async () => {
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({ checkEnvironment: () => { throw new Error("invalid"); } }),
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(body.data.checks.environment, { status: "fail", required: true });
});

test("production readiness returns HTTP 503 when storage is unavailable", async () => {
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({ checkStorage: () => { throw new Error("missing"); } }),
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(body.data.checks.storage, { status: "fail", required: true });
});

test("production readiness returns HTTP 503 when storage is not writable", async () => {
  const notWritable = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({ checkStorage: () => { throw notWritable; } }),
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(body.data.checks.storage, { status: "fail", required: true });
});

test("production readiness returns HTTP 503 after graceful shutdown starts", async () => {
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({ isShuttingDown: () => true }),
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(body.data.checks.shutdown, { status: "fail", required: true });
});

test("production readiness requires an available worker when worker mode is enabled", async () => {
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({ checkIndexingWorker: () => { throw new Error("offline"); } }),
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(body.data.checks.indexingWorker, { status: "fail", required: true });
});

test("production readiness skips the worker check when worker mode is intentionally disabled", async () => {
  let workerChecks = 0;
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({
      workerEnabled: false,
      checkIndexingWorker: () => { workerChecks += 1; },
    }),
  ));
  assert.equal(response.status, 200);
  assert.equal(workerChecks, 0);
  assert.deepEqual(body.data.checks.indexingWorker, { status: "skip", required: false });
});

test("production readiness bounds dependency checks with a short timeout", async () => {
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({ checkSupabase: () => new Promise<void>(() => undefined) }),
    5,
  ));
  assert.equal(response.status, 503);
  assert.deepEqual(body.data.checks.supabase, { status: "fail", required: true });
});

test("production readiness responses never expose dependency diagnostics", async () => {
  const secret = "sk-secret Bearer token https://db.example.test /private/repos JWT-value";
  const error = new Error(secret);
  error.stack = `${secret}\n at internal.ts:1`;
  const { response, body } = await request(createProductionReadinessCheck(
    dependencies({
      checkSupabase: () => { throw error; },
      checkEnvironment: () => { throw error; },
      checkStorage: () => { throw error; },
      checkIndexingWorker: () => { throw error; },
    }),
  ));
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 503);
  for (const value of ["sk-secret", "Bearer", "db.example.test", "/private/repos", "JWT-value", "internal.ts"]) {
    assert.equal(serialized.includes(value), false);
  }
});
