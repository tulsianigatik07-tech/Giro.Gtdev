import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import type {
  CreateIndexingJobInput,
  IndexingJobFailure,
} from "../services/indexing/jobs/indexingJobStore.js";

let store: MemoryIndexingJobStore;

const BASE_INPUT: CreateIndexingJobInput = {
  repositoryId: "acme/demo",
  ownerUserId: "user-1",
  repositoryOwner: "acme",
  repositoryName: "demo",
  repositoryUrl: "https://github.com/acme/demo",
  branch: "main",
};

const FAILURE: IndexingJobFailure = {
  code: "clone_failed",
  message: "Clone failed",
  retryable: true,
};

function input(repositoryId: string): CreateIndexingJobInput {
  const [owner = "acme", repo = "demo"] = repositoryId.split("/");
  return {
    ...BASE_INPUT,
    repositoryId,
    repositoryOwner: owner,
    repositoryName: repo,
    repositoryUrl: `https://github.com/${owner}/${repo}`,
  };
}

beforeEach(() => {
  store = new MemoryIndexingJobStore();
});

test("empty store lists no jobs and handles unknown IDs", async () => {
  assert.deepEqual(await store.listJobs(), []);
  assert.deepEqual(await store.listRepositoryJobs("acme/demo"), []);
  assert.equal(await store.getLatestRepositoryJob("acme/demo"), null);
  assert.equal(await store.getJob("missing"), null);
  assert.equal(await store.claimNextJob("worker-1"), null);
  assert.equal(await store.updateProgress("missing", 10), null);
  assert.equal(await store.markSucceeded("missing"), null);
  assert.equal(await store.markFailed("missing", FAILURE), null);
  assert.equal(await store.cancelJob("missing"), null);
  assert.equal(await store.deleteJob("missing"), false);
});

test("create job assigns deterministic ID, sequence, and created order", async () => {
  const first = await store.createJob(BASE_INPUT);
  const second = await store.createJob(input("acme/api"));

  assert.equal(first.jobId, "indexing-job-1");
  assert.equal(second.jobId, "indexing-job-2");
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(first.createdOrder, 1);
  assert.equal(second.createdOrder, 2);
  assert.equal(first.status, "queued");
  assert.equal(first.progress, 0);
  assert.equal(first.currentStage, "pending");
  assert.equal(first.attempt, 1);
});

test("retrieve, list, repository listing, and latest repository job are deterministic", async () => {
  store = new MemoryIndexingJobStore({ maxConcurrentPerUser: 10 });
  const first = await store.createJob(input("zeta/web"));
  const second = await store.createJob(input("acme/api"));
  const third = await store.createJob(input("acme/demo"));

  assert.deepEqual(await store.getJob(second.jobId), second);
  assert.deepEqual(
    (await store.listJobs()).map((job) => job.jobId),
    [first.jobId, second.jobId, third.jobId],
  );
  assert.deepEqual(
    (await store.listJobs({ ownerUserId: "user-1" })).map((job) => job.jobId),
    [first.jobId, second.jobId, third.jobId],
  );
  assert.deepEqual(await store.listRepositoryJobs("acme/demo"), [third]);
  assert.deepEqual(await store.getLatestRepositoryJob("acme/demo"), third);
});

test("prevents duplicate active jobs for the same repository", async () => {
  const first = await store.createJob(BASE_INPUT);
  const duplicate = await store.createJob(BASE_INPUT);

  assert.equal(duplicate.jobId, first.jobId);
  assert.equal((await store.listRepositoryJobs(BASE_INPUT.repositoryId)).length, 1);
});

test("allows a new repository job after prior job is terminal", async () => {
  const first = await store.createJob(BASE_INPUT);
  await store.cancelJob(first.jobId);
  const second = await store.createJob(BASE_INPUT);

  assert.notEqual(second.jobId, first.jobId);
  assert.equal(second.sequence, 2);
  assert.equal((await store.listRepositoryJobs(BASE_INPUT.repositoryId)).length, 2);
});

test("claim next queued job is ordered and cannot claim same job twice", async () => {
  const first = await store.createJob(input("acme/a"));
  const second = await store.createJob(input("acme/b"));

  const claimed = await store.claimNextJob("worker-1");
  assert.equal(claimed?.jobId, first.jobId);
  assert.equal(claimed?.status, "claimed");
  assert.equal(claimed?.claimedBy, "worker-1");
  assert.equal(claimed?.startedOrder, 3);

  const next = await store.claimNextJob("worker-2");
  assert.equal(next?.jobId, second.jobId);
  assert.notEqual(next?.jobId, claimed?.jobId);
});

test("concurrent Promise-based claim attempts do not return the same job twice", async () => {
  const first = await store.createJob(input("acme/a"));
  const second = await store.createJob(input("acme/b"));

  const claimed = await Promise.all([
    store.claimNextJob("worker-1"),
    store.claimNextJob("worker-2"),
    store.claimNextJob("worker-3"),
  ]);

  const claimedIds = claimed
    .filter((job) => job !== null)
    .map((job) => job.jobId)
    .sort();
  assert.deepEqual(claimedIds, [first.jobId, second.jobId].sort());
  assert.equal(new Set(claimedIds).size, claimedIds.length);
  assert.equal(claimed.filter((job) => job === null).length, 1);
});

test("mark running and update progress without decreasing progress", async () => {
  const job = await store.createJob(BASE_INPUT);
  await store.claimNextJob("worker-1");

  const running = await store.markRunning(job.jobId, "clone");
  assert.equal(running?.status, "running");
  assert.equal(running?.currentStage, "clone");

  const progressed = await store.updateProgress(job.jobId, 40, "scan");
  assert.equal(progressed?.progress, 40);
  assert.equal(progressed?.currentStage, "scan");

  assert.equal(await store.updateProgress(job.jobId, 39, "structure"), null);
  assert.equal((await store.getJob(job.jobId))?.progress, 40);
  assert.equal(await store.updateProgress(job.jobId, 100, "finalize"), null);
});

test("mark succeeded completes running job", async () => {
  const job = await store.createJob(BASE_INPUT);
  await store.claimNextJob("worker-1");
  await store.markRunning(job.jobId, "clone");
  await store.updateProgress(job.jobId, 80, "finalize");

  const succeeded = await store.markSucceeded(job.jobId);

  assert.equal(succeeded?.status, "succeeded");
  assert.equal(succeeded?.progress, 100);
  assert.equal(succeeded?.currentStage, "complete");
  assert.notEqual(succeeded?.completedOrder, null);
});

test("mark failed records structured failure", async () => {
  const job = await store.createJob(BASE_INPUT);
  await store.claimNextJob("worker-1");
  await store.markRunning(job.jobId, "clone");

  const failed = await store.markFailed(job.jobId, FAILURE);

  assert.equal(failed?.status, "failed");
  assert.deepEqual(failed?.failure, FAILURE);
  assert.notEqual(failed?.completedOrder, null);
});

test("cancel queued job", async () => {
  const job = await store.createJob(BASE_INPUT);
  const cancelled = await store.cancelJob(job.jobId);

  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.claimedBy, null);
  assert.notEqual(cancelled?.completedOrder, null);
});

test("delete job and clear store", async () => {
  const first = await store.createJob(input("acme/a"));
  await store.createJob(input("acme/b"));

  assert.equal(await store.deleteJob(first.jobId), true);
  assert.equal(await store.getJob(first.jobId), null);

  await store.clear();

  assert.deepEqual(await store.listJobs(), []);
  const afterClear = await store.createJob(input("acme/c"));
  assert.equal(afterClear.jobId, "indexing-job-1");
  assert.equal(afterClear.createdOrder, 1);
});

test("returned jobs are defensive copies", async () => {
  const created = await store.createJob(BASE_INPUT);
  created.failure = FAILURE;
  created.repositoryName = "mutated";

  const found = await store.getJob(created.jobId);
  assert.ok(found);
  assert.equal(found.repositoryName, "demo");
  assert.equal(found.failure, null);

  await store.claimNextJob("worker-1");
  await store.markRunning(created.jobId);
  const failed = await store.markFailed(created.jobId, FAILURE);
  assert.ok(failed?.failure);
  failed.failure.message = "mutated";

  assert.equal((await store.getJob(created.jobId))?.failure?.message, "Clone failed");
});

test("repeated reads are deterministic with distinct references", async () => {
  const job = await store.createJob(BASE_INPUT);
  const first = await store.getJob(job.jobId);
  const second = await store.getJob(job.jobId);

  assert.deepEqual(second, first);
  assert.notEqual(second, first);
});
