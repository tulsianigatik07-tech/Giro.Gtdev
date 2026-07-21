import assert from "node:assert/strict";
import test from "node:test";

import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import type {
  IndexingJob,
  IndexingJobFailure,
  StaleIndexingJobRecoveryInput,
  SupervisedIndexingJobStore,
} from "../services/indexing/jobs/indexingJobStore.js";
import type { IndexingJobExecutionReport } from "../services/indexing/jobs/indexingJobWorker.js";
import {
  ContinuousIndexingWorker,
  retryDelayMs,
  type ContinuousIndexingWorkerConfig,
} from "../services/indexing/worker/continuousIndexingWorker.js";
import type {
  IndexingWorkerHealthUpdate,
  IndexingWorkerStateStore,
} from "../services/indexing/worker/indexingWorkerStateStore.js";

const CONFIG: ContinuousIndexingWorkerConfig = {
  workerId: "worker-a",
  pollIntervalMs: 10,
  idleBackoffMs: 10,
  maxPollIntervalMs: 30,
  staleClaimMs: 100,
  heartbeatMs: 10,
  retryBaseMs: 20,
  retryMaxMs: 80,
  shutdownTimeoutMs: 15,
};

const IDLE: IndexingJobExecutionReport = {
  processed: false,
  jobId: null,
  repositoryId: null,
  status: "idle",
  stagesCompleted: [],
  failure: null,
};

class SupervisedMemoryStore extends MemoryIndexingJobStore implements SupervisedIndexingJobStore {
  heartbeats: Array<{ jobId: string; workerId: string }> = [];
  retries: Array<{ jobId: string; workerId: string; failure: IndexingJobFailure; delayMs: number }> = [];
  recoveries: StaleIndexingJobRecoveryInput[] = [];
  recovered: IndexingJob[] = [];

  override async heartbeatJob(jobId: string, workerId: string): Promise<boolean> {
    this.heartbeats.push({ jobId, workerId });
    return true;
  }

  override async scheduleRetry(jobId: string, workerId: string, failure: IndexingJobFailure, delayMs: number) {
    this.retries.push({ jobId, workerId, failure, delayMs });
    const job = await this.getJob(jobId);
    return job ? { ...job, status: "queued" as const, attempt: job.attempt + 1 } : null;
  }

  override async recoverStaleJobs(input: StaleIndexingJobRecoveryInput): Promise<IndexingJob[]> {
    this.recoveries.push(input);
    return this.recovered;
  }
}

class HealthStore implements IndexingWorkerStateStore {
  updates: IndexingWorkerHealthUpdate[] = [];
  async record(update: IndexingWorkerHealthUpdate): Promise<void> {
    this.updates.push(structuredClone(update));
  }
}

const logger = {
  entries: [] as Array<{ event: string; fields?: Record<string, unknown> }>,
  info(event: string, fields?: Record<string, unknown>) { this.entries.push({ event, fields }); },
  error(event: string, fields?: Record<string, unknown>) { this.entries.push({ event, fields }); },
};

async function createClaimedJob(store: SupervisedMemoryStore, maxAttempts = 3) {
  const created = await store.createJob({
    repositoryId: "acme/repo",
    ownerUserId: "user-1",
    repositoryOwner: "acme",
    repositoryName: "repo",
    repositoryUrl: "https://github.com/acme/repo",
    maxAttempts,
  });
  return { ...created, status: "claimed" as const, claimedBy: CONFIG.workerId };
}

test("continuous worker polls repeatedly and applies bounded idle backoff", async () => {
  const store = new SupervisedMemoryStore();
  const health = new HealthStore();
  const sleeps: number[] = [];
  let polls = 0;
  let worker: ContinuousIndexingWorker;
  const workerLogs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  worker = new ContinuousIndexingWorker({
    config: CONFIG,
    jobStore: store,
    stateStore: health,
    logger: {
      info: (event, fields) => workerLogs.push({ event, fields }),
      error: (event, fields) => workerLogs.push({ event, fields }),
    },
    executeNext: async () => {
      polls += 1;
      if (polls === 3) worker.requestShutdown("SIGTERM");
      return IDLE;
    },
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => 1_000,
  });

  assert.equal(await worker.run(), 0);
  assert.equal(polls, 3);
  assert.deepEqual(sleeps, [20, 30]);
  assert.equal(store.recoveries.length, 1);
  assert.ok(health.updates.some((update) => update.polled));
  assert.deepEqual(workerLogs.map((entry) => entry.event), [
    "indexing_worker_started",
    "indexing_recovery_started",
    "indexing_recovery_completed",
    "indexing_worker_shutdown_requested",
    "indexing_worker_finished",
  ]);
  const finished = workerLogs.at(-1)?.fields;
  assert.equal(finished?.workerId, "worker-a");
  assert.equal(finished?.durationMs, 0);
});

test("successful execution records the completed job", async () => {
  const store = new SupervisedMemoryStore();
  const health = new HealthStore();
  const job = await createClaimedJob(store);
  const worker = new ContinuousIndexingWorker({
    config: CONFIG, jobStore: store, stateStore: health, logger,
    executeNext: async ({ observer }) => {
      await observer?.onClaimed?.(job);
      return { ...IDLE, processed: true, status: "succeeded", jobId: job.jobId, repositoryId: job.repositoryId };
    },
  });
  await worker.pollOnce();
  assert.ok(health.updates.some((update) => update.lastCompletedJobId === job.jobId));
});

test("retryable failures schedule a bounded durable retry", async () => {
  const store = new SupervisedMemoryStore();
  const job = await createClaimedJob(store);
  const failure = { code: "git_unavailable", message: "Git service unavailable.", retryable: true };
  const worker = new ContinuousIndexingWorker({
    config: CONFIG, jobStore: store, stateStore: new HealthStore(), logger,
    executeNext: async ({ observer }) => {
      await observer?.onClaimed?.(job);
      return { ...IDLE, processed: true, status: "failed", jobId: job.jobId, repositoryId: job.repositoryId, failure };
    },
  });
  await worker.pollOnce();
  assert.equal(store.retries.length, 1);
  assert.equal(store.retries[0]?.delayMs, 20);
  assert.equal(retryDelayMs(10, 20, 80), 80);
});

test("terminal failures and exhausted attempts are not retried", async () => {
  for (const failure of [
    { code: "invalid_repository", message: "Invalid repository.", retryable: false },
    { code: "git_unavailable", message: "Git unavailable.", retryable: true },
  ]) {
    const store = new SupervisedMemoryStore();
    const job = await createClaimedJob(store, failure.retryable ? 1 : 3);
    const worker = new ContinuousIndexingWorker({
      config: CONFIG, jobStore: store, stateStore: new HealthStore(), logger,
      executeNext: async ({ observer }) => {
        await observer?.onClaimed?.(job);
        return { ...IDLE, processed: true, status: "failed", jobId: job.jobId, repositoryId: job.repositoryId, failure };
      },
    });
    await worker.pollOnce();
    assert.equal(store.retries.length, 0);
  }
});

test("shutdown prevents new claims", async () => {
  let calls = 0;
  const worker = new ContinuousIndexingWorker({
    config: CONFIG,
    jobStore: new SupervisedMemoryStore(),
    stateStore: new HealthStore(),
    logger,
    executeNext: async () => { calls += 1; return IDLE; },
  });
  worker.requestShutdown("SIGINT");
  assert.equal(await worker.pollOnce(), null);
  assert.equal(calls, 0);
});

test("shutdown timeout aborts an active job and returns failure", async () => {
  const store = new SupervisedMemoryStore();
  const job = await createClaimedJob(store);
  let worker: ContinuousIndexingWorker;
  worker = new ContinuousIndexingWorker({
    config: CONFIG,
    jobStore: store,
    stateStore: new HealthStore(),
    logger,
    executeNext: ({ signal, observer }) => new Promise(async (resolve) => {
      await observer?.onClaimed?.(job);
      worker.requestShutdown("SIGTERM");
      signal?.addEventListener("abort", () => resolve(IDLE), { once: true });
    }),
    sleep: async () => undefined,
    now: () => 1_000,
  });
  assert.equal(await worker.run(), 1);
});

test("worker logs only identifiers and sanitized failure messages", async () => {
  const store = new SupervisedMemoryStore();
  const job = await createClaimedJob(store);
  const entries: string[] = [];
  const safeLogger = {
    info(event: string, fields?: Record<string, unknown>) { entries.push(JSON.stringify({ event, fields })); },
    error(event: string, fields?: Record<string, unknown>) { entries.push(JSON.stringify({ event, fields })); },
  };
  const worker = new ContinuousIndexingWorker({
    config: CONFIG, jobStore: store, stateStore: new HealthStore(), logger: safeLogger,
    executeNext: async ({ observer }) => {
      await observer?.onClaimed?.(job);
      return { ...IDLE, processed: true, status: "failed", jobId: job.jobId, repositoryId: job.repositoryId,
        failure: { code: "invalid_repository", message: "Repository input is invalid.", retryable: false } };
    },
  });
  await worker.pollOnce();
  const output = entries.join("\n");
  assert.doesNotMatch(output, /github\.com|source code|token/i);
});
