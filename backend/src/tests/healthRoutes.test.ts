import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../app.js";
import type { ApplicationReadiness } from "../services/health/readinessService.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";

type Envelope = {
  success: boolean;
  data: Record<string, unknown>;
  requestId: string;
};

async function request(
  path: string,
  readinessCheck: () => Promise<ApplicationReadiness>,
) {
  const app = createApp({ indexingJobStore, readinessCheck });
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

test("legacy health route remains backward compatible", async () => {
  const { response, body } = await request("/health", async () => ready);

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.status, "ok");
  assert.equal(typeof body.data.uptime_s, "number");
  assert.equal(typeof body.data.timestamp, "string");
});
