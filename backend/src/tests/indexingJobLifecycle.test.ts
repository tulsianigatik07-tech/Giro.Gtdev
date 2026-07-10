import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canRetryIndexingJob,
  canTransitionIndexingJob,
  listAllowedIndexingJobTransitions,
  transitionIndexingJob,
  validateIndexingJobProgress,
} from "../services/indexing/jobs/indexingJobLifecycle.js";
import type {
  IndexingJob,
  IndexingJobFailure,
  IndexingJobStatus,
} from "../services/indexing/jobs/indexingJobStore.js";

const FAILURE: IndexingJobFailure = {
  code: "indexing_failed",
  message: "Indexing failed",
  retryable: true,
};

function job(overrides: Partial<IndexingJob> = {}): IndexingJob {
  return {
    jobId: "indexing-job-1",
    repositoryId: "acme/demo",
    ownerUserId: "user-1",
    repositoryOwner: "acme",
    repositoryName: "demo",
    repositoryUrl: "https://github.com/acme/demo",
    branch: "main",
    status: "queued",
    sequence: 1,
    attempt: 1,
    maxAttempts: 3,
    progress: 0,
    currentStage: "pending",
    failure: null,
    claimedBy: null,
    createdOrder: 1,
    startedOrder: null,
    completedOrder: null,
    ...overrides,
  };
}

test("allowed transitions match indexing job lifecycle table", () => {
  const expected: Record<IndexingJobStatus, IndexingJobStatus[]> = {
    queued: ["claimed", "cancelled"],
    claimed: ["running", "cancelled"],
    running: ["succeeded", "failed"],
    succeeded: [],
    failed: ["queued"],
    cancelled: [],
  };

  for (const [status, transitions] of Object.entries(expected) as Array<
    [IndexingJobStatus, IndexingJobStatus[]]
  >) {
    assert.deepEqual(listAllowedIndexingJobTransitions(status), transitions);
    for (const next of transitions) {
      assert.equal(canTransitionIndexingJob(status, next), true);
    }
  }
});

test("invalid transitions return explicit errors", () => {
  const result = transitionIndexingJob(job(), "succeeded");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "invalid_transition");
  }
});

test("successful completion sets complete stage and progress 100", () => {
  const result = transitionIndexingJob(
    job({ status: "running", progress: 80, currentStage: "finalize" }),
    "succeeded",
    { order: 5 },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.job.status, "succeeded");
    assert.equal(result.job.progress, 100);
    assert.equal(result.job.currentStage, "complete");
    assert.equal(result.job.completedOrder, 5);
  }
});

test("failure transition records structured failure", () => {
  const result = transitionIndexingJob(
    job({ status: "running", progress: 25, currentStage: "clone" }),
    "failed",
    { failure: FAILURE, order: 4 },
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.job.status, "failed");
    assert.deepEqual(result.job.failure, FAILURE);
    assert.equal(result.job.progress, 25);
    assert.equal(result.job.completedOrder, 4);
  }
});

test("cancellation is allowed from queued and claimed only", () => {
  assert.equal(transitionIndexingJob(job(), "cancelled", { order: 2 }).ok, true);
  assert.equal(
    transitionIndexingJob(job({ status: "claimed", claimedBy: "worker-1" }), "cancelled", {
      order: 3,
    }).ok,
    true,
  );
  assert.equal(transitionIndexingJob(job({ status: "running" }), "cancelled").ok, false);
});

test("retryable failure can return to queued when attempts remain", () => {
  const result = transitionIndexingJob(
    job({ status: "failed", failure: FAILURE, attempt: 1, maxAttempts: 3 }),
    "queued",
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.job.status, "queued");
    assert.equal(result.job.attempt, 2);
    assert.equal(result.job.failure, null);
  }
});

test("non-retryable failure cannot be retried", () => {
  const failed = job({
    status: "failed",
    failure: { ...FAILURE, retryable: false },
  });

  assert.equal(canRetryIndexingJob(failed), false);
  const result = transitionIndexingJob(failed, "queued");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "retry_not_allowed");
  }
});

test("maximum attempts reached prevents retry", () => {
  const failed = job({
    status: "failed",
    failure: FAILURE,
    attempt: 3,
    maxAttempts: 3,
  });

  assert.equal(canRetryIndexingJob(failed), false);
  assert.equal(transitionIndexingJob(failed, "queued").ok, false);
});

test("progress validation rejects invalid, decreasing, and premature complete progress", () => {
  const running = job({ status: "running", progress: 50 });

  assert.equal(validateIndexingJobProgress(running, -1)?.code, "invalid_progress");
  assert.equal(validateIndexingJobProgress(running, 101)?.code, "invalid_progress");
  assert.equal(validateIndexingJobProgress(running, 50.5)?.code, "invalid_progress");
  assert.equal(validateIndexingJobProgress(running, 49)?.code, "progress_decreased");
  assert.equal(
    validateIndexingJobProgress(running, 100)?.code,
    "incomplete_progress_complete",
  );
  assert.equal(validateIndexingJobProgress(running, 75), null);
});

test("transition does not mutate input job", () => {
  const input = job({ status: "running", progress: 30, currentStage: "scan" });
  const before = structuredClone(input);

  transitionIndexingJob(input, "failed", { failure: FAILURE, order: 2 });

  assert.deepEqual(input, before);
});

test("transition output is deterministic", () => {
  const input = job({ status: "claimed", claimedBy: "worker-1" });

  const first = transitionIndexingJob(input, "running", { stage: "clone" });
  const second = transitionIndexingJob(input, "running", { stage: "clone" });

  assert.deepEqual(second, first);
});
