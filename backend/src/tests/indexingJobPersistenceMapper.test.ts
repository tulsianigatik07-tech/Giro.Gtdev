import assert from "node:assert/strict";
import { test } from "node:test";

import {
  indexingJobRowToDomain,
  indexingJobToInsertRow,
  indexingJobToUpdateRow,
  type IndexingJobPersistenceRow,
} from "../services/indexing/jobs/indexingJobPersistenceMapper.js";
import type { IndexingJob } from "../services/indexing/jobs/indexingJobStore.js";

function job(overrides: Partial<IndexingJob> = {}): IndexingJob {
  return {
    jobId: "indexing-job-1",
    repositoryId: "acme/demo",
    ownerUserId: "user-1",
    repositoryOwner: "acme",
    repositoryName: "demo",
    repositoryUrl: "https://github.com/acme/demo",
    branch: null,
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

function row(
  overrides: Partial<IndexingJobPersistenceRow> = {},
): IndexingJobPersistenceRow {
  return {
    job_id: "indexing-job-1",
    repository_id: "acme/demo",
    owner_user_id: "user-1",
    repository_owner: "acme",
    repository_name: "demo",
    repository_url: "https://github.com/acme/demo",
    branch: null,
    status: "queued",
    sequence: 1,
    attempt: 1,
    max_attempts: 3,
    progress: 0,
    current_stage: "pending",
    failure_code: null,
    failure_message: null,
    failure_retryable: null,
    claimed_by: null,
    created_order: 1,
    started_order: null,
    completed_order: null,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

test("maps a complete queued job to a snake_case insert row", () => {
  assert.deepEqual(indexingJobToInsertRow(job()), {
    job_id: "indexing-job-1",
    repository_id: "acme/demo",
    owner_user_id: "user-1",
    repository_owner: "acme",
    repository_name: "demo",
    repository_url: "https://github.com/acme/demo",
    branch: null,
    status: "queued",
    sequence: 1,
    attempt: 1,
    max_attempts: 3,
    progress: 0,
    current_stage: "pending",
    failure_code: null,
    failure_message: null,
    failure_retryable: null,
    claimed_by: null,
    created_order: 1,
    started_order: null,
    completed_order: null,
  });
});

test("maps claimed and running jobs without inventing order values", () => {
  const claimed = job({
    status: "claimed",
    claimedBy: "worker-1",
    startedOrder: 2,
  });
  const running = job({
    status: "running",
    currentStage: "scan",
    progress: 25,
    claimedBy: "worker-1",
    startedOrder: 2,
  });

  assert.equal(indexingJobToInsertRow(claimed).claimed_by, "worker-1");
  assert.equal(indexingJobToInsertRow(claimed).started_order, 2);
  assert.deepEqual(indexingJobToUpdateRow(running), {
    status: "running",
    attempt: 1,
    max_attempts: 3,
    progress: 25,
    current_stage: "scan",
    failure_code: null,
    failure_message: null,
    failure_retryable: null,
    claimed_by: "worker-1",
    started_order: 2,
    completed_order: null,
  });
});

test("maps succeeded job completion fields", () => {
  const mapped = indexingJobToInsertRow(job({
    status: "succeeded",
    progress: 100,
    currentStage: "complete",
    claimedBy: "worker-1",
    startedOrder: 2,
    completedOrder: 3,
  }));

  assert.equal(mapped.status, "succeeded");
  assert.equal(mapped.progress, 100);
  assert.equal(mapped.current_stage, "complete");
  assert.equal(mapped.completed_order, 3);
});

test("maps failed job structured failure fields", () => {
  const mapped = indexingJobToInsertRow(job({
    status: "failed",
    currentStage: "embed",
    progress: 90,
    claimedBy: "worker-1",
    startedOrder: 2,
    completedOrder: 3,
    failure: {
      code: "embedding_failed",
      message: "Repository embedding failed.",
      retryable: true,
    },
  }));

  assert.equal(mapped.failure_code, "embedding_failed");
  assert.equal(mapped.failure_message, "Repository embedding failed.");
  assert.equal(mapped.failure_retryable, true);
});

test("preserves explicit nullable failure and branch fields", () => {
  const mapped = indexingJobToInsertRow(job({ branch: null, failure: null }));

  assert.equal(mapped.branch, null);
  assert.equal(mapped.failure_code, null);
  assert.equal(mapped.failure_message, null);
  assert.equal(mapped.failure_retryable, null);
});

test("rejects inconsistent partial persisted failure data without inventing values", () => {
  assert.throws(
    () => indexingJobRowToDomain(row({
      status: "failed",
      failure_code: "indexing_failed",
      failure_message: null,
      failure_retryable: null,
    })),
    /Invalid persisted indexing job failure/,
  );
});

test("maps persistence row to a defensive domain object without timestamps", () => {
  const input = row({
    status: "failed",
    current_stage: "scan",
    progress: 25,
    claimed_by: "worker-1",
    started_order: 2,
    completed_order: 3,
    failure_code: "indexing_failed",
    failure_message: "Repository indexing failed.",
    failure_retryable: true,
  });
  const mapped = indexingJobRowToDomain(input);

  assert.deepEqual(mapped.failure, {
    code: "indexing_failed",
    message: "Repository indexing failed.",
    retryable: true,
  });
  assert.equal("created_at" in mapped, false);
  assert.equal("updated_at" in mapped, false);
  if (mapped.failure) mapped.failure.message = "mutated";
  assert.equal(input.failure_message, "Repository indexing failed.");
});

test("mapping is deterministic across repeated calls", () => {
  const input = job({ branch: "main" });

  assert.deepEqual(indexingJobToInsertRow(input), indexingJobToInsertRow(input));
  assert.deepEqual(indexingJobToUpdateRow(input), indexingJobToUpdateRow(input));
  assert.deepEqual(indexingJobRowToDomain(row()), indexingJobRowToDomain(row()));
});

test("mappers do not mutate domain or persistence input", () => {
  const domainInput = job({
    failure: { code: "indexing_failed", message: "Failed", retryable: true },
  });
  const rowInput = row();
  const domainBefore = structuredClone(domainInput);
  const rowBefore = structuredClone(rowInput);

  indexingJobToInsertRow(domainInput);
  indexingJobToUpdateRow(domainInput);
  indexingJobRowToDomain(rowInput);

  assert.deepEqual(domainInput, domainBefore);
  assert.deepEqual(rowInput, rowBefore);
});

test("domain to row to domain round trip preserves every domain field", () => {
  const input = job({
    status: "failed",
    branch: "main",
    attempt: 2,
    currentStage: "graph",
    progress: 70,
    claimedBy: "worker-2",
    startedOrder: 8,
    completedOrder: 9,
    failure: { code: "indexing_failed", message: "Failed", retryable: true },
  });

  assert.deepEqual(
    indexingJobRowToDomain(indexingJobToInsertRow(input)),
    input,
  );
});
