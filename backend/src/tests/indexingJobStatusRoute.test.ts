import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import type {
  CreateIndexingJobInput,
  IndexingJobFailure,
} from "../services/indexing/jobs/indexingJobStore.js";
import {
  clearRepositoryOwners,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";
import {
  clearRepositoryIndexRegistry,
  getRepositoryIndexMetadata,
} from "../services/repository/indexingService.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

const TOKEN_A = `Bearer ${await signAccessToken(USER_A)}`;
const TOKEN_B = `Bearer ${await signAccessToken(USER_B)}`;

const BASE_JOB: CreateIndexingJobInput = {
  repositoryId: "acme/demo",
  ownerUserId: USER_A.userId,
  repositoryOwner: "acme",
  repositoryName: "demo",
  repositoryUrl: "https://github.com/acme/demo",
  branch: "main",
};

type ApiResponse = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
    category?: string;
    retryable?: boolean;
    status?: number;
  };
};

async function request(
  jobId: string,
  token?: string,
): Promise<{ status: number; body: ApiResponse }> {
  const app = createApp();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = token;
  const res = await app.request(`/indexing/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
    headers,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as ApiResponse,
  };
}

async function connect(
  token = TOKEN_A,
): Promise<{ status: number; body: ApiResponse }> {
  const app = createApp();
  const res = await app.request("/repos/connect", {
    method: "POST",
    headers: {
      authorization: token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ repoUrl: "https://github.com/acme/connectqueued" }),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as ApiResponse,
  };
}

async function createOwnedJob(input: CreateIndexingJobInput = BASE_JOB) {
  setRepositoryOwner(input.repositoryId, input.ownerUserId);
  return indexingJobStore.createJob(input);
}

beforeEach(async () => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
  await indexingJobStore.clear();
});

test("unauthenticated request returns existing 401 behavior", async () => {
  const result = await request("indexing-job-1");

  assert.equal(result.status, 401);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error?.code, "unauthorized");
});

test("invalid job ID returns validation_failed", async () => {
  const result = await request("bad id", TOKEN_A);

  assert.equal(result.status, 400);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error?.code, "validation_failed");
});

test("unknown job returns stable not-found error", async () => {
  const result = await request("indexing-job-404", TOKEN_A);

  assert.equal(result.status, 404);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error?.code, "indexing_job_not_found");
});

test("owner can read queued job", async () => {
  const job = await createOwnedJob();
  const result = await request(job.jobId, TOKEN_A);

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, {
    jobId: "indexing-job-1",
    repositoryId: "acme/demo",
    status: "queued",
    progress: 0,
    currentStage: "pending",
    attempt: 1,
    maxAttempts: 3,
    failure: null,
  });
});

test("owner can read running job", async () => {
  const job = await createOwnedJob();
  await indexingJobStore.claimNextJob("worker-1");
  await indexingJobStore.markRunning(job.jobId, "scan");
  await indexingJobStore.updateProgress(job.jobId, 25, "scan");

  const result = await request(job.jobId, TOKEN_A);

  assert.equal(result.status, 200);
  assert.equal(result.body.data?.status, "running");
  assert.equal(result.body.data?.progress, 25);
  assert.equal(result.body.data?.currentStage, "scan");
});

test("owner can read succeeded job", async () => {
  const job = await createOwnedJob();
  await indexingJobStore.claimNextJob("worker-1");
  await indexingJobStore.markRunning(job.jobId, "finalize");
  await indexingJobStore.updateProgress(job.jobId, 95, "finalize");
  await indexingJobStore.markSucceeded(job.jobId);

  const result = await request(job.jobId, TOKEN_A);

  assert.equal(result.status, 200);
  assert.equal(result.body.data?.status, "succeeded");
  assert.equal(result.body.data?.progress, 100);
  assert.equal(result.body.data?.currentStage, "complete");
});

test("owner can read failed job with safe structured failure fields only", async () => {
  const job = await createOwnedJob();
  await indexingJobStore.claimNextJob("worker-1");
  await indexingJobStore.markRunning(job.jobId, "clone");
  const failure = {
    code: "clone_failed",
    message: "Repository clone failed.",
    retryable: true,
    stack: "hidden",
    providerPayload: { secret: "hidden" },
  } as IndexingJobFailure;
  await indexingJobStore.markFailed(job.jobId, failure);

  const result = await request(job.jobId, TOKEN_A);

  assert.equal(result.status, 200);
  assert.equal(result.body.data?.status, "failed");
  assert.deepEqual(result.body.data?.failure, {
    code: "clone_failed",
    message: "Repository clone failed.",
    retryable: true,
  });
  assert.deepEqual(Object.keys(result.body.data?.failure as Record<string, unknown>), [
    "code",
    "message",
    "retryable",
  ]);
});

test("foreign user cannot read the job", async () => {
  const job = await createOwnedJob();

  const result = await request(job.jobId, TOKEN_B);

  assert.equal(result.status, 403);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error?.code, "repo_not_owned");
});

test("repository ownership missing follows existing missing behavior", async () => {
  const job = await indexingJobStore.createJob(BASE_JOB);

  const result = await request(job.jobId, TOKEN_A);

  assert.equal(result.status, 404);
  assert.equal(result.body.success, false);
  assert.equal(result.body.error?.code, "repo_not_connected");
});

test("internal fields are not exposed", async () => {
  const job = await createOwnedJob();
  await indexingJobStore.claimNextJob("worker-1");

  const result = await request(job.jobId, TOKEN_A);

  assert.equal(result.status, 200);
  const data = result.body.data ?? {};
  assert.equal("claimedBy" in data, false);
  assert.equal("createdOrder" in data, false);
  assert.equal("startedOrder" in data, false);
  assert.equal("completedOrder" in data, false);
  assert.equal("sequence" in data, false);
  assert.equal("ownerUserId" in data, false);
  assert.equal("repositoryUrl" in data, false);
  assert.equal("branch" in data, false);
});

test("response ordering and shape are deterministic", async () => {
  const job = await createOwnedJob();

  const first = await request(job.jobId, TOKEN_A);
  const second = await request(job.jobId, TOKEN_A);

  const keys = [
    "jobId",
    "repositoryId",
    "status",
    "progress",
    "currentStage",
    "attempt",
    "maxAttempts",
    "failure",
  ];
  assert.deepEqual(Object.keys(first.body.data ?? {}), keys);
  assert.deepEqual(Object.keys(second.body.data ?? {}), keys);
  assert.deepEqual(second.body.data, first.body.data);
});

test("internal store failure returns internal_error without stack leakage", async () => {
  const original = indexingJobStore.getJob.bind(indexingJobStore);
  indexingJobStore.getJob = async () => {
    throw new Error("store exploded\nstack trace");
  };

  try {
    const result = await request("indexing-job-1", TOKEN_A);

    assert.equal(result.status, 500);
    assert.equal(result.body.error?.code, "internal_error");
    assert.equal(result.body.error?.message?.includes("stack"), false);
  } finally {
    indexingJobStore.getJob = original;
  }
});

test("existing POST /repos/connect behavior remains unchanged", async () => {
  const result = await connect();

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.data?.repositoryId, "acme/connectqueued");
  assert.equal(result.body.data?.jobId, "indexing-job-1");
  assert.equal(result.body.data?.status, "queued");
  assert.equal(getRepositoryIndexMetadata("acme", "connectqueued")?.status, "indexing");
});
