import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  getProcessNextIndexingJobCommandExitCode,
  isValidIndexingWorkerId,
  resolveIndexingWorkerId,
  runProcessNextIndexingJobCommand,
} from "../commands/processNextIndexingJob.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import type { CreateIndexingJobInput } from "../services/indexing/jobs/indexingJobStore.js";
import type {
  ExecuteIndexingPipeline,
  IndexingJobRepositoryStore,
} from "../services/indexing/jobs/indexingJobWorker.js";
import { clearRepositoryOwners, setRepositoryOwner } from "../services/repository/ownershipStore.js";

const BASE_JOB: CreateIndexingJobInput = {
  repositoryId: "owner/repo",
  ownerUserId: "user-1",
  repositoryOwner: "owner",
  repositoryName: "repo",
  repositoryUrl: "https://github.com/owner/repo",
  branch: null,
};

const SUCCESS_PIPELINE: ExecuteIndexingPipeline = async () => ({
  counts: {
    chunkCount: 1,
    fileCount: 1,
    symbolCount: 1,
    graphNodeCount: 1,
    graphEdgeCount: 0,
    summaryAvailable: true,
  },
});

let jobStore: MemoryIndexingJobStore;
let outputs: string[];
let repositoryCalls: string[];
let repositoryStore: IndexingJobRepositoryStore;

beforeEach(() => {
  clearRepositoryOwners();
  setRepositoryOwner(BASE_JOB.repositoryId, BASE_JOB.ownerUserId);
  jobStore = new MemoryIndexingJobStore();
  outputs = [];
  repositoryCalls = [];
  repositoryStore = {
    markIndexing(job) {
      repositoryCalls.push(`indexing:${job.repositoryId}`);
    },
    markIndexed(job) {
      repositoryCalls.push(`indexed:${job.repositoryId}`);
    },
    markFailed(job) {
      repositoryCalls.push(`failed:${job.repositoryId}`);
    },
  };
});

async function run(
  executeIndexingPipeline: ExecuteIndexingPipeline = SUCCESS_PIPELINE,
  workerId = "manual-worker",
) {
  return runProcessNextIndexingJobCommand({
    workerId,
    jobStore,
    repositoryStore,
    executeIndexingPipeline,
    writeOutput: (output) => outputs.push(output),
  });
}

test("empty queue prints one deterministic idle JSON result with exit code zero", async () => {
  const first = await run();
  const firstOutput = outputs[0];

  outputs = [];
  const second = await run();

  const expected = {
    command: "indexing:work-once",
    processed: false,
    status: "idle",
    jobId: null,
    repositoryId: null,
    failure: null,
  };
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.equal(firstOutput, JSON.stringify(expected));
  assert.deepEqual(outputs, [JSON.stringify(expected)]);
  assert.equal(getProcessNextIndexingJobCommandExitCode(first), 0);
  assert.deepEqual(repositoryCalls, []);
});

test("one queued job succeeds using injected stores and pipeline", async () => {
  const job = await jobStore.createJob(BASE_JOB);
  let pipelineCalls = 0;

  const result = await run(async (input) => {
    pipelineCalls += 1;
    assert.equal(input.job.jobId, job.jobId);
    return SUCCESS_PIPELINE(input);
  });

  assert.deepEqual(result, {
    command: "indexing:work-once",
    processed: true,
    status: "succeeded",
    jobId: "indexing-job-1",
    repositoryId: "owner/repo",
    failure: null,
  });
  assert.equal(outputs.length, 1);
  assert.equal(pipelineCalls, 1);
  assert.deepEqual(repositoryCalls, ["indexing:owner/repo", "indexed:owner/repo"]);
  assert.equal((await jobStore.getJob(job.jobId))?.status, "succeeded");
  assert.equal(getProcessNextIndexingJobCommandExitCode(result), 0);
});

test("processes at most one queued job", async () => {
  const first = await jobStore.createJob(BASE_JOB);
  const second = await jobStore.createJob({
    ...BASE_JOB,
    repositoryId: "owner/second",
    repositoryName: "second",
    repositoryUrl: "https://github.com/owner/second",
  });

  const result = await run();

  assert.equal(result.jobId, first.jobId);
  assert.equal((await jobStore.getJob(first.jobId))?.status, "succeeded");
  assert.equal((await jobStore.getJob(second.jobId))?.status, "queued");
});

test("passes the stable worker ID to claimNextJob", async () => {
  let claimedBy: string | null = null;
  const originalClaimNextJob = jobStore.claimNextJob.bind(jobStore);
  jobStore.claimNextJob = async (workerId) => {
    claimedBy = workerId;
    return originalClaimNextJob(workerId);
  };

  await run(SUCCESS_PIPELINE, "scheduler-worker-1");

  assert.equal(claimedBy, "scheduler-worker-1");
});

test("failed job prints only the structured safe failure and maps to exit one", async () => {
  await jobStore.createJob(BASE_JOB);
  const result = await run(async ({ reportStage }) => {
    await reportStage({ stage: "scan", progress: 25 });
    throw new Error("provider exploded\nstack trace: secret-token");
  });

  assert.deepEqual(result, {
    command: "indexing:work-once",
    processed: true,
    status: "failed",
    jobId: "indexing-job-1",
    repositoryId: "owner/repo",
    failure: {
      code: "indexing_failed",
      message: "Repository indexing failed.",
      retryable: true,
    },
  });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.includes("stack"), false);
  assert.equal(outputs[0]?.includes("secret-token"), false);
  assert.deepEqual(repositoryCalls, ["indexing:owner/repo", "failed:owner/repo"]);
  assert.equal(getProcessNextIndexingJobCommandExitCode(result), 1);
});

test("output omits internal worker and store metadata", async () => {
  await jobStore.createJob(BASE_JOB);

  await run();

  const parsed = JSON.parse(outputs[0] ?? "{}") as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    "command",
    "processed",
    "status",
    "jobId",
    "repositoryId",
    "failure",
  ]);
  for (const key of [
    "claimedBy",
    "createdOrder",
    "startedOrder",
    "completedOrder",
    "stagesCompleted",
    "repositoryUrl",
    "ownerUserId",
  ]) {
    assert.equal(key in parsed, false);
  }
});

test("unexpected store failure is normalized without raw error details", async () => {
  jobStore.claimNextJob = async () => {
    throw new Error("database password leaked\nstack trace");
  };

  const result = await run();

  assert.deepEqual(result.failure, {
    code: "internal_error",
    message: "Indexing worker command failed.",
    retryable: false,
  });
  assert.equal(result.processed, false);
  assert.equal(getProcessNextIndexingJobCommandExitCode(result), 1);
  assert.equal(outputs[0]?.includes("password"), false);
  assert.equal(outputs[0]?.includes("stack"), false);
});

test("worker ID resolution is deterministic and validation rejects unsafe IDs", () => {
  assert.equal(resolveIndexingWorkerId([], undefined), "manual-worker");
  assert.equal(resolveIndexingWorkerId([], "environment-worker"), "environment-worker");
  assert.equal(
    resolveIndexingWorkerId(["--worker-id", "argument-worker"], "environment-worker"),
    "argument-worker",
  );
  assert.equal(resolveIndexingWorkerId(["--worker-id=inline-worker"], undefined), "inline-worker");

  for (const workerId of ["", "has space", "../worker", "worker..id", "a".repeat(65)]) {
    assert.equal(isValidIndexingWorkerId(workerId), false);
  }
  assert.equal(isValidIndexingWorkerId("manual-worker_1.prod"), true);
});

test("invalid worker ID prints one safe failure without claiming a job", async () => {
  await jobStore.createJob(BASE_JOB);
  let claimCalls = 0;
  jobStore.claimNextJob = async () => {
    claimCalls += 1;
    return null;
  };

  const result = await run(SUCCESS_PIPELINE, "../unsafe");

  assert.equal(result.status, "failed");
  assert.equal(result.failure?.message, "Invalid indexing worker ID.");
  assert.equal(claimCalls, 0);
  assert.equal(outputs.length, 1);
  assert.equal(getProcessNextIndexingJobCommandExitCode(result), 1);
});

test("reusable command does not assign process.exitCode or call process.exit", async () => {
  const originalExitCode = process.exitCode;
  process.exitCode = 73;
  try {
    const result = await run();
    assert.equal(result.status, "idle");
    assert.equal(process.exitCode, 73);
  } finally {
    process.exitCode = originalExitCode;
  }
});
