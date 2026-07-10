import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import {
  INDEXING_JOB_STAGE_PROGRESS,
  normalizeIndexingJobFailure,
  processNextIndexingJob,
  type ExecuteIndexingPipeline,
  type IndexingJobRepositoryStore,
} from "../services/indexing/jobs/indexingJobWorker.js";
import type {
  CreateIndexingJobInput,
  IndexingJob,
  IndexingJobFailure,
  IndexingJobStage,
} from "../services/indexing/jobs/indexingJobStore.js";
import {
  clearRepositoryIndexRegistry,
  getRepositoryIndexMetadata,
} from "../services/repository/indexingService.js";
import {
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";

const USER = { userId: "user-1", email: "user@example.com" };
const TOKEN = `Bearer ${await signAccessToken(USER)}`;

const BASE_JOB: CreateIndexingJobInput = {
  repositoryId: "acme/demo",
  ownerUserId: USER.userId,
  repositoryOwner: "acme",
  repositoryName: "demo",
  repositoryUrl: "https://github.com/acme/demo",
  branch: "main",
};

const SUCCESS_COUNTS = {
  chunkCount: 5,
  fileCount: 3,
  symbolCount: 4,
  graphNodeCount: 2,
  graphEdgeCount: 1,
  summaryAvailable: true,
};

let store: MemoryIndexingJobStore;

function jobInput(repositoryId: string): CreateIndexingJobInput {
  const [owner = "acme", repo = "demo"] = repositoryId.split("/");
  return {
    ...BASE_JOB,
    repositoryId,
    repositoryOwner: owner,
    repositoryName: repo,
    repositoryUrl: `https://github.com/${owner}/${repo}`,
  };
}

function successPipeline(
  seen?: Array<{ stage: IndexingJobStage; progress: number }>,
): ExecuteIndexingPipeline {
  return async ({ reportStage }) => {
    for (const stageProgress of INDEXING_JOB_STAGE_PROGRESS) {
      await reportStage(stageProgress);
      seen?.push(stageProgress);
    }
    return {
      counts: SUCCESS_COUNTS,
      indexOptions: {
        indexMode: "full",
        changedFileCount: 3,
      },
    };
  };
}

function failingPipeline(
  stage: IndexingJobStage,
  error: Error,
): ExecuteIndexingPipeline {
  return async ({ reportStage }) => {
    const progress = INDEXING_JOB_STAGE_PROGRESS.find((item) => item.stage === stage);
    if (progress) await reportStage(progress);
    throw error;
  };
}

async function connect(): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = createApp({ indexingJobStore });
  const res = await app.request("/repos/connect", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: TOKEN,
    },
    body: JSON.stringify({ repoUrl: "https://github.com/acme/routequeued" }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

beforeEach(async () => {
  store = new MemoryIndexingJobStore();
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
  await indexingJobStore.clear();
});

test("no queued job returns idle result", async () => {
  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: successPipeline(),
  });

  assert.deepEqual(report, {
    processed: false,
    jobId: null,
    repositoryId: null,
    status: "idle",
    stagesCompleted: [],
    failure: null,
  });
});

test("claims one queued job and processes only one job per call", async () => {
  const first = await store.createJob(jobInput("acme/a"));
  const second = await store.createJob(jobInput("acme/b"));

  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: successPipeline(),
  });

  assert.equal(report.processed, true);
  assert.equal(report.jobId, first.jobId);
  assert.equal((await store.getJob(first.jobId))?.status, "succeeded");
  assert.equal((await store.getJob(second.jobId))?.status, "queued");
});

test("transitions claimed to running and records deterministic stage progress", async () => {
  const seen: Array<{ stage: IndexingJobStage; progress: number; jobProgress: number }> = [];
  const job = await store.createJob(BASE_JOB);

  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: async ({ reportStage }) => {
      for (const stageProgress of INDEXING_JOB_STAGE_PROGRESS) {
        await reportStage(stageProgress);
        const current = await store.getJob(job.jobId);
        seen.push({
          ...stageProgress,
          jobProgress: current?.progress ?? -1,
        });
      }
      return {
        counts: SUCCESS_COUNTS,
        indexOptions: { indexMode: "full", changedFileCount: 3 },
      };
    },
  });

  assert.equal(report.status, "succeeded");
  assert.deepEqual(
    seen.map((item) => item.stage),
    ["clone", "scan", "structure", "symbols", "graph", "chunk", "embed", "finalize"],
  );
  assert.deepEqual(
    seen.map((item) => item.jobProgress),
    [10, 25, 40, 55, 70, 80, 90, 95],
  );
  assert.equal((await store.getJob(job.jobId))?.status, "succeeded");
  assert.equal((await store.getJob(job.jobId))?.currentStage, "complete");
});

test("successful indexing marks job succeeded, repository indexed, and progress 100", async () => {
  const job = await store.createJob(BASE_JOB);
  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: successPipeline(),
  });

  const stored = await store.getJob(job.jobId);
  const metadata = getRepositoryIndexMetadata("acme", "demo");
  assert.equal(report.status, "succeeded");
  assert.equal(stored?.status, "succeeded");
  assert.equal(stored?.progress, 100);
  assert.equal(metadata?.status, "indexed");
  assert.equal(metadata?.chunkCount, SUCCESS_COUNTS.chunkCount);
  assert.equal(metadata?.fileCount, SUCCESS_COUNTS.fileCount);
  assert.equal(metadata?.symbolCount, SUCCESS_COUNTS.symbolCount);
  assert.equal(metadata?.graphNodeCount, SUCCESS_COUNTS.graphNodeCount);
  assert.equal(metadata?.graphEdgeCount, SUCCESS_COUNTS.graphEdgeCount);
  assert.equal(metadata?.lastIndexMode, "full");
  assert.equal(metadata?.lastChangedFileCount, 3);
});

test("clone failure marks job failed and repository failed", async () => {
  const job = await store.createJob(BASE_JOB);
  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: failingPipeline(
      "clone",
      new Error("Clone failed: operation timed out"),
    ),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure?.code, "clone_failed");
  assert.equal(report.failure?.retryable, true);
  assert.equal((await store.getJob(job.jobId))?.status, "failed");
  assert.equal(getRepositoryIndexMetadata("acme", "demo")?.status, "failed");
});

test("indexing failure marks job failed and keeps failure structured", async () => {
  const job = await store.createJob(BASE_JOB);
  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: failingPipeline("scan", new Error("scan exploded\nstack line")),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure?.code, "indexing_failed");
  assert.equal(report.failure?.message.includes("stack line"), false);
  assert.equal((await store.getJob(job.jobId))?.failure?.code, "indexing_failed");
  assert.equal(getRepositoryIndexMetadata("acme", "demo")?.status, "failed");
});

test("embedding and OpenAI failures use external failure codes", () => {
  const openai = normalizeIndexingJobFailure(new Error("OpenAI rate limit"), {
    repositoryId: "acme/demo",
    stage: "embed",
  });
  const embedding = normalizeIndexingJobFailure(new Error("vector write failed"), {
    repositoryId: "acme/demo",
    stage: "embed",
  });

  assert.equal(openai.code, "openai_unavailable");
  assert.equal(openai.retryable, true);
  assert.equal(embedding.code, "embedding_failed");
  assert.equal(embedding.retryable, true);
});

test("repository store update failure marks job failed without stack trace", async () => {
  const job = await store.createJob(BASE_JOB);
  const calls: string[] = [];
  const repositoryStore: IndexingJobRepositoryStore = {
    markIndexing() {
      calls.push("indexing");
    },
    markIndexed() {
      throw new Error("repository store mark indexed failed\nstack trace");
    },
    markFailed() {
      calls.push("failed");
    },
  };

  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    repositoryStore,
    executeIndexingPipeline: successPipeline(),
  });

  assert.equal(report.status, "failed");
  assert.equal(report.failure?.code, "internal_error");
  assert.equal(report.failure?.message.includes("stack"), false);
  assert.equal((await store.getJob(job.jobId))?.status, "failed");
  assert.deepEqual(calls, ["indexing", "failed"]);
});

test("second worker cannot process already claimed job", async () => {
  const job = await store.createJob(BASE_JOB);
  await store.claimNextJob("worker-1");

  const report = await processNextIndexingJob({
    workerId: "worker-2",
    jobStore: store,
    executeIndexingPipeline: successPipeline(),
  });

  assert.equal(report.status, "idle");
  assert.equal((await store.getJob(job.jobId))?.claimedBy, "worker-1");
});

test("concurrent workers do not process the same job", async () => {
  const job = await store.createJob(BASE_JOB);
  const reports = await Promise.all([
    processNextIndexingJob({
      workerId: "worker-1",
      jobStore: store,
      executeIndexingPipeline: successPipeline(),
    }),
    processNextIndexingJob({
      workerId: "worker-2",
      jobStore: store,
      executeIndexingPipeline: successPipeline(),
    }),
  ]);

  assert.equal(reports.filter((report) => report.jobId === job.jobId).length, 1);
  assert.equal(reports.filter((report) => report.status === "idle").length, 1);
});

test("repeated calls process queued jobs in deterministic order", async () => {
  const first = await store.createJob(jobInput("acme/a"));
  const second = await store.createJob(jobInput("acme/b"));

  const firstReport = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: successPipeline(),
  });
  const secondReport = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: successPipeline(),
  });

  assert.equal(firstReport.jobId, first.jobId);
  assert.equal(secondReport.jobId, second.jobId);
});

test("worker does not mutate injected job input", async () => {
  const job = await store.createJob(BASE_JOB);
  let pipelineJob: IndexingJob | null = null;

  await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    executeIndexingPipeline: async ({ job: inputJob, reportStage }) => {
      pipelineJob = inputJob;
      inputJob.repositoryName = "mutated";
      await reportStage({ stage: "clone", progress: 10 });
      return {
        counts: SUCCESS_COUNTS,
        indexOptions: { indexMode: "full", changedFileCount: 1 },
      };
    },
  });

  assert.ok(pipelineJob);
  assert.equal((await store.getJob(job.jobId))?.repositoryName, "demo");
});

test("connect route remains queue-only and does not invoke worker pipeline", async () => {
  const result = await connect();

  assert.equal(result.status, 200);
  const data = result.body.data as Record<string, unknown>;
  assert.equal(data.status, "queued");
  assert.equal(data.jobId, "indexing-job-1");
  assert.equal((await indexingJobStore.getJob("indexing-job-1"))?.status, "queued");
  assert.equal(getRepositoryIndexMetadata("acme", "routequeued")?.status, "indexing");
});
