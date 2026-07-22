import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createApp } from "../app.js";
import { createDeadline } from "../runtime/deadline.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { processNextIndexingJob } from "../services/indexing/jobs/indexingJobWorker.js";
import { cloneRepo } from "../services/repository/clone.js";
import { MemoryRepositoryConnectionStore } from "../services/repository/connection/memoryRepositoryConnectionStore.js";
import {
  RepositoryConnectionIdempotencyConflictError,
  repositoryConnectionPayloadHash,
  type ConnectRepositoryTransactionInput,
} from "../services/repository/connection/repositoryConnectionStore.js";
import { SupabaseRepositoryConnectionStore } from "../services/repository/connection/supabaseRepositoryConnectionStore.js";
import { MemoryRepositoryStore } from "../services/repository/store/memoryRepositoryStore.js";
import { repositoryStore as runtimeRepositoryStore } from "../services/repository/store/runtimeRepositoryStore.js";

function input(overrides: Partial<ConnectRepositoryTransactionInput> = {}): ConnectRepositoryTransactionInput {
  const base = {
    idempotencyKey: "connect-1",
    ownerUserId: "user-1",
    repositoryOwner: "acme",
    repositoryName: "api",
    repositoryUrl: "https://github.com/acme/api",
    branch: null,
    requestId: "request-1",
    traceparent: null,
  };
  return {
    ...base,
    ...overrides,
    payloadHash: repositoryConnectionPayloadHash({ ...base, ...overrides }),
  };
}

test("connection endpoint accepts a client key and preserves successful replay shape", async () => {
  await runtimeRepositoryStore.clear();
  const jobs = new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 });
  const connections = new MemoryRepositoryConnectionStore(runtimeRepositoryStore, jobs);
  const app = createApp({ indexingJobStore: jobs, repositoryConnectionStore: connections });
  const authorization = `Bearer ${await signAccessToken({ userId: "user-1", email: "user@example.com" })}`;
  const request = (repoUrl: string) => app.request("/repos/connect", {
    method: "POST",
    headers: { authorization, "content-type": "application/json", "Idempotency-Key": "route-connect-1" },
    body: JSON.stringify({ repoUrl }),
  });
  const first = await request("https://github.com/acme/api");
  const replay = await request("https://github.com/acme/api");
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  const firstBody = await first.json() as { data?: unknown };
  const replayBody = await replay.json() as { data?: unknown };
  assert.deepEqual(replayBody.data, firstBody.data);
  const conflict = await request("https://github.com/acme/web");
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { error?: { code?: string } }).error?.code, "idempotency_conflict");
  await runtimeRepositoryStore.clear();
});

test("identical repository connection retry replays the exact successful response", async () => {
  const repositories = new MemoryRepositoryStore();
  const jobs = new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 });
  const store = new MemoryRepositoryConnectionStore(repositories, jobs);
  const first = await store.connect(input());
  const replay = await store.connect(input({ requestId: "request-2" }));
  assert.deepEqual(replay.response, first.response);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal((await jobs.listJobs()).length, 1);
});

test("same idempotency key rejects a conflicting payload", async () => {
  const store = new MemoryRepositoryConnectionStore(
    new MemoryRepositoryStore(),
    new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 }),
  );
  await store.connect(input());
  await assert.rejects(
    store.connect(input({ repositoryName: "web", repositoryUrl: "https://github.com/acme/web" })),
    RepositoryConnectionIdempotencyConflictError,
  );
});

test("cancellation before commit rolls back repository and job state", async () => {
  const repositories = new MemoryRepositoryStore();
  const jobs = new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 });
  const controller = new AbortController();
  const originalCreate = jobs.createJob.bind(jobs);
  jobs.createJob = async (jobInput) => {
    const job = await originalCreate(jobInput);
    controller.abort(new DOMException("cancelled", "AbortError"));
    return job;
  };
  const store = new MemoryRepositoryConnectionStore(repositories, jobs);
  await assert.rejects(store.connect(input({ signal: controller.signal })), { name: "AbortError" });
  assert.equal(await repositories.getRepository("acme/api"), null);
  assert.deepEqual(await jobs.listJobs(), []);
});

test("durable operation failure rolls back repository creation", async () => {
  const repositories = new MemoryRepositoryStore();
  const jobs = new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 });
  jobs.createJob = async () => { throw new Error("durable write failed"); };
  const store = new MemoryRepositoryConnectionStore(repositories, jobs);
  await assert.rejects(store.connect(input()), /durable write failed/);
  assert.equal(await repositories.getRepository("acme/api"), null);
});

test("concurrent identical connections commit once and replay once", async () => {
  const jobs = new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 });
  const store = new MemoryRepositoryConnectionStore(new MemoryRepositoryStore(), jobs);
  const results = await Promise.all([store.connect(input()), store.connect(input())]);
  assert.deepEqual(results[0]?.response, results[1]?.response);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.equal((await jobs.listJobs()).length, 1);
});

test("concurrent conflicting connections allow exactly one payload", async () => {
  const store = new MemoryRepositoryConnectionStore(
    new MemoryRepositoryStore(),
    new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 }),
  );
  const results = await Promise.allSettled([
    store.connect(input()),
    store.connect(input({ repositoryName: "web", repositoryUrl: "https://github.com/acme/web" })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejection.reason instanceof RepositoryConnectionIdempotencyConflictError);
});

test("expired idempotency records are cleaned deterministically", async () => {
  let now = 1_000;
  const store = new MemoryRepositoryConnectionStore(
    new MemoryRepositoryStore(),
    new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 }),
    { retentionMs: 100, now: () => now },
  );
  await store.connect(input());
  assert.equal(await store.cleanupExpired(), 0);
  now += 101;
  assert.equal(await store.cleanupExpired(), 1);
  assert.equal(await store.cleanupExpired(), 0);
});

test("memory and Supabase connection stores expose equivalent replay results", async () => {
  const memory = new MemoryRepositoryConnectionStore(
    new MemoryRepositoryStore(),
    new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 }),
  );
  const expected = await memory.connect(input());
  let observedSignal: AbortSignal | undefined;
  const supabase = new SupabaseRepositoryConnectionStore({
    rpc: (_name: string) => {
      const result = Promise.resolve({
        data: [{
          response: expected.response,
          job: {
            job_id: expected.job.jobId, repository_id: expected.job.repositoryId,
            owner_user_id: expected.job.ownerUserId, repository_owner: expected.job.repositoryOwner,
            repository_name: expected.job.repositoryName, repository_url: expected.job.repositoryUrl,
            branch: null, status: "queued", sequence: 1, attempt: 1, max_attempts: 3,
            progress: 0, current_stage: "pending", failure_code: null, failure_message: null,
            failure_retryable: null, claimed_by: null, claim_token: null, created_order: 1,
            started_order: null, completed_order: null,
          },
          replayed: false,
        }],
        error: null,
      }) as Promise<never> & { abortSignal?: (signal: AbortSignal) => Promise<never> };
      result.abortSignal = (signal) => { observedSignal = signal; return result; };
      return result;
    },
  });
  const controller = new AbortController();
  const actual = await supabase.connect(input({ signal: controller.signal }));
  assert.deepEqual(actual.response, expected.response);
  assert.equal(observedSignal, controller.signal);
});

test("Supabase startup validation verifies objects and runs expiration cleanup", async () => {
  const calls: string[] = [];
  const store = new SupabaseRepositoryConnectionStore({
    rpc: (name: string) => {
      calls.push(name);
      return Promise.resolve({
        data: name === "verify_repository_connection_idempotency" ? true : 4,
        error: null,
      });
    },
  });
  await store.verify();
  assert.equal(await store.cleanupExpired(), 4);
  assert.deepEqual(calls, [
    "verify_repository_connection_idempotency",
    "cleanup_repository_connection_idempotency",
  ]);
});

test("cancellation is propagated into clone execution and removes the checkout", async () => {
  const controller = new AbortController();
  const deadline = createDeadline(5_000, { parentSignal: controller.signal });
  let observedSignal: AbortSignal | undefined;
  try {
    await assert.rejects(cloneRepo("abort-test", "clone", {
      deadline,
      executeClone: async (_url, _path, _timeout, signal) => {
        observedSignal = signal;
        controller.abort(new DOMException("clone cancelled", "AbortError"));
        signal?.throwIfAborted();
      },
    }), /clone cancelled/);
    assert.equal(observedSignal, deadline.signal);
  } finally {
    deadline.dispose();
  }
});

test("worker cancellation reaches indexing and prevents successful completion", async () => {
  const repositories = new MemoryRepositoryStore();
  repositories.connectRepository({ owner: "acme", repo: "cancel", ownerUserId: "user-1" });
  const jobs = new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 });
  await jobs.createJob({
    repositoryId: "acme/cancel", ownerUserId: "user-1", repositoryOwner: "acme",
    repositoryName: "cancel", repositoryUrl: "https://github.com/acme/cancel", branch: null,
  });
  const controller = new AbortController();
  const report = await processNextIndexingJob({
    workerId: "worker-1", jobStore: jobs, repositoryAuthorizationStore: repositories,
    repositoryStore: { markIndexing: () => undefined, markIndexed: () => undefined, markFailed: () => undefined },
    signal: controller.signal,
    executeIndexingPipeline: async ({ signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort(new DOMException("indexing cancelled", "AbortError"));
      signal?.throwIfAborted();
      throw new Error("unreachable");
    },
  });
  assert.equal(report.status, "failed");
  assert.notEqual((await jobs.getJob(report.jobId!))?.status, "succeeded");
});

test("idempotency migration defines atomic transaction, cleanup, constraints, and statement timeout", async () => {
  const migration = await readFile(
    new URL("../../supabase/migrations/20260730000000_add_idempotent_repository_connection.sql", import.meta.url),
    "utf8",
  );
  for (const contract of [
    "repository_connection_idempotency", "connect_repository_idempotently",
    "pg_advisory_xact_lock", "idempotency_conflict", "cleanup_repository_connection_idempotency",
    "verify_repository_connection_idempotency", "statement_timeout", "on delete cascade",
    "grant execute", "enable row level security",
  ]) assert.match(migration, new RegExp(contract, "i"));
});
