import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { processNextIndexingJob } from "../services/indexing/jobs/indexingJobWorker.js";
import { setRepositoryOwner } from "../services/repository/ownershipStore.js";

function loggingApp() {
  const entries: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const times = [100, 112];
  const app = createApp({
    indexingJobStore: new MemoryIndexingJobStore(),
    requestContext: {
      generateRequestId: () => "generated-id",
      monotonicNow: () => times.shift() ?? 112,
      logger: {
        info: (event, fields) => entries.push({ event, fields }),
        error: (event, fields) => entries.push({ event, fields }),
      },
    },
  });
  return { app, entries };
}

test("request logging emits start and finish with safe method, status, and duration", async () => {
  const { app, entries } = loggingApp();
  const response = await app.request("/health/live", {
    headers: {
      "X-Request-ID": "trusted-id",
      Authorization: "Bearer secret-token",
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(entries, [
    {
      event: "request_started",
      fields: {
        method: "GET",
        route: "/health/live",
      },
    },
    {
      event: "request_finished",
      fields: {
        requestId: "trusted-id",
        method: "GET",
        route: "/health/live",
        status: 200,
        durationMs: 12,
      },
    },
  ]);
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("Authorization"), false);
});

test("existing response-envelope request ID matches the correlation header", async () => {
  const { app } = loggingApp();
  const response = await app.request("/health/live", {
    headers: { "X-Request-ID": "envelope-request-id" },
  });
  const body = await response.json() as { requestId: string };

  assert.equal(body.requestId, "envelope-request-id");
  assert.equal(response.headers.get("X-Request-ID"), "envelope-request-id");
});

test("CORS exposes request correlation, rate limit, and additive confidence headers", async () => {
  const { app } = loggingApp();
  const response = await app.request("/health/live", {
    headers: { Origin: "http://localhost:3000" },
  });

  assert.equal(
    response.headers.get("access-control-expose-headers"),
    "X-Request-ID,X-RateLimit-Limit,X-RateLimit-Remaining,Retry-After,X-Retrieval-Confidence",
  );
});

test("auth failure, validation failure, 404, internal error, and readiness 503 retain headers", async () => {
  const { app } = loggingApp();
  app.get("/throws", () => { throw new Error("internal secret"); });
  const token = `Bearer ${await signAccessToken({ userId: "user", email: "u@example.com" })}`;
  const requests = [
    app.request("/sessions"),
    app.request("/repos/connect", {
      method: "POST",
      headers: { authorization: token, "content-type": "application/json" },
      body: "{}",
    }),
    app.request("/missing"),
    app.request("/throws"),
  ];

  for (const response of await Promise.all(requests)) {
    assert.equal(response.headers.get("X-Request-ID"), "generated-id");
  }

  const unavailable = createApp({
    indexingJobStore: new MemoryIndexingJobStore(),
    readinessCheck: async () => ({ status: "not_ready", checks: [] }),
    requestContext: {
      generateRequestId: () => "readiness-id",
      logger: { info: () => undefined, error: () => undefined },
    },
  });
  const readiness = await unavailable.request("/health/ready");
  assert.equal(readiness.status, 503);
  assert.equal(readiness.headers.get("X-Request-ID"), "readiness-id");
});

test("request logging never includes request bodies", async () => {
  const { app, entries } = loggingApp();
  await app.request("/repos/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "private question body", apiKey: "sk-secret" }),
  });

  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes("private question body"), false);
  assert.equal(serialized.includes("sk-secret"), false);
});

test("unexpected exceptions log a stack internally without exposing it in the response", async () => {
  const { app, entries } = loggingApp();
  app.get("/unexpected", () => {
    throw new Error("internal exception detail");
  });

  const response = await app.request("/unexpected");
  const serializedBody = JSON.stringify(await response.json());
  const failure = entries.find((entry) => entry.event === "unhandled_error");

  assert.equal(response.status, 500);
  assert.equal(typeof failure?.fields?.stack, "string");
  assert.equal(serializedBody.includes("internal exception detail"), false);
  assert.equal(serializedBody.includes("requestLogging.test"), false);
});

test("connect persists request correlation without changing its public response", async () => {
  const store = new MemoryIndexingJobStore();
  const user = { userId: "correlation-user", email: "user@example.com" };
  const token = `Bearer ${await signAccessToken(user)}`;
  const app = createApp({
    indexingJobStore: store,
    requestContext: {
      logger: { info: () => undefined, error: () => undefined },
    },
  });
  const response = await app.request("/repos/connect", {
    method: "POST",
    headers: {
      authorization: token,
      "content-type": "application/json",
      "X-Request-ID": "connect-request-id",
    },
    body: JSON.stringify({ repoUrl: "https://github.com/acme/correlated" }),
  });
  const body = await response.json() as { data: Record<string, unknown> };
  const [job] = await store.listJobs();

  assert.equal(job?.createdByRequestId, "connect-request-id");
  assert.deepEqual(Object.keys(body.data).sort(), ["jobId", "repositoryId", "status"]);
});

test("worker lifecycle logs include job and originating request correlation safely", async () => {
  const store = new MemoryIndexingJobStore();
  await store.createJob({
    repositoryId: "acme/worker",
    ownerUserId: "user",
    repositoryOwner: "acme",
    repositoryName: "worker",
    repositoryUrl: "https://github.com/acme/worker",
    createdByRequestId: "origin-request-id",
  });
  setRepositoryOwner("acme/worker", "user");
  const entries: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
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
    logger: {
      info: (event, fields) => entries.push({ event, fields }),
      error: (event, fields) => entries.push({ event, fields }),
    },
  });

  assert.deepEqual(entries.map((entry) => entry.event), [
    "indexing_job_claimed",
    "indexing_job_started",
    "indexing_job_succeeded",
  ]);
  for (const entry of entries) {
    assert.equal(entry.fields?.jobId, "indexing-job-1");
    assert.equal(entry.fields?.repositoryId, "acme/worker");
    assert.equal(entry.fields?.workerId, "worker-1");
    assert.equal(entry.fields?.requestId, "origin-request-id");
  }
});

test("worker failure logs normalize provider errors and secrets", async () => {
  const store = new MemoryIndexingJobStore();
  await store.createJob({
    repositoryId: "acme/failure",
    ownerUserId: "user",
    repositoryOwner: "acme",
    repositoryName: "failure",
    repositoryUrl: "https://github.com/acme/failure",
    createdByRequestId: "failure-request-id",
  });
  setRepositoryOwner("acme/failure", "user");
  const entries: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: async () => {
      throw new Error("sk-secret provider payload\n/private/stack.ts");
    },
    logger: {
      info: (event, fields) => entries.push({ event, fields }),
      error: (event, fields) => entries.push({ event, fields }),
    },
  });

  const failed = entries.find((entry) => entry.event === "indexing_job_failed");
  assert.equal(failed?.fields?.requestId, "failure-request-id");
  assert.equal(failed?.fields?.failureCode, "clone_failed");
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes("sk-secret"), false);
  assert.equal(serialized.includes("provider payload"), false);
  assert.equal(serialized.includes("stack.ts"), false);
});
