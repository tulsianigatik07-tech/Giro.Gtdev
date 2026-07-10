import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { repoClonePath } from "../services/repository/clone.js";
import {
  clearRepositoryIndexRegistry,
  getRepositoryIndexMetadata,
  setRepositoryIndexed,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  clearRepositoryOwners,
  getRepositoryOwner,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

const TOKEN_A = `Bearer ${await signAccessToken(USER_A)}`;
const TOKEN_B = `Bearer ${await signAccessToken(USER_B)}`;

const COUNTS: IndexedCounts = {
  chunkCount: 7,
  fileCount: 5,
  symbolCount: 3,
  graphNodeCount: 2,
  graphEdgeCount: 1,
  summaryAvailable: true,
};

type ApiResponse = {
  success?: boolean;
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
    category?: string;
    status?: number;
    retryable?: boolean;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object", "expected object");
  return value as Record<string, unknown>;
}

async function call(
  token: string | undefined,
  body: unknown,
): Promise<{ status: number; body: ApiResponse }> {
  const app = createApp({ indexingJobStore });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = token;

  const res = await app.request("/repos/connect", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const responseBody = (await res.json().catch(() => ({}))) as ApiResponse;
  return { status: res.status, body: responseBody };
}

beforeEach(async () => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
  await indexingJobStore.clear();
});

test("connect returns queued indexing job immediately", async () => {
  const result = await call(TOKEN_A, {
    repoUrl: "https://github.com/acme/queuefoundation",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  const data = asRecord(result.body.data);
  assert.equal(data.repositoryId, "acme/queuefoundation");
  assert.equal(data.jobId, "indexing-job-1");
  assert.equal(data.status, "queued");

  const job = await indexingJobStore.getJob("indexing-job-1");
  assert.equal(job?.repositoryId, "acme/queuefoundation");
  assert.equal(job?.ownerUserId, USER_A.userId);
  assert.equal(job?.repositoryUrl, "https://github.com/acme/queuefoundation");
});

test("connect marks repository indexing but does not mark indexed", async () => {
  const result = await call(TOKEN_A, {
    repoUrl: "https://github.com/acme/indexingstate",
  });
  assert.equal(result.status, 200);

  const metadata = getRepositoryIndexMetadata("acme", "indexingstate");
  assert.equal(metadata?.status, "indexing");
  assert.equal(metadata?.indexedAt, null);
  assert.equal(metadata?.chunkCount, 0);
  assert.equal(metadata?.fileCount, 0);
  assert.equal(metadata?.symbolCount, 0);
  assert.equal(metadata?.graphNodeCount, 0);
  assert.equal(metadata?.graphEdgeCount, 0);
  assert.equal(metadata?.lastIndexMode, null);
  assert.equal(metadata?.totalIndexedFiles, 0);
});

test("connect records repository ownership for the authenticated user", async () => {
  const result = await call(TOKEN_A, {
    repoUrl: "https://github.com/acme/ownedqueued",
  });

  assert.equal(result.status, 200);
  assert.equal(getRepositoryOwner("acme/ownedqueued"), USER_A.userId);
});

test("connect does not clone repository", async () => {
  const owner = "acme";
  const repo = "queuefoundationnevercloned";
  const clonePath = repoClonePath(owner, repo);
  assert.equal(existsSync(clonePath), false);

  const result = await call(TOKEN_A, {
    repoUrl: `https://github.com/${owner}/${repo}`,
  });

  assert.equal(result.status, 200);
  assert.equal(existsSync(clonePath), false);
});

test("connect does not execute indexing work for an already indexed repository", async () => {
  setRepositoryOwner("acme/alreadyindexed", USER_A.userId);
  setRepositoryIndexed("acme", "alreadyindexed", COUNTS);
  const before = getRepositoryIndexMetadata("acme", "alreadyindexed");

  const result = await call(TOKEN_A, {
    repoUrl: "https://github.com/acme/alreadyindexed",
  });

  assert.equal(result.status, 200);
  const metadata = getRepositoryIndexMetadata("acme", "alreadyindexed");
  assert.equal(metadata?.status, "indexing");
  assert.equal(metadata?.indexedAt, before?.indexedAt);
  assert.equal(metadata?.chunkCount, COUNTS.chunkCount);
  assert.equal(metadata?.lastIndexMode, null);
});

test("duplicate connect returns the active queued job", async () => {
  const first = await call(TOKEN_A, {
    repoUrl: "https://github.com/acme/duplicatejob",
  });
  const second = await call(TOKEN_A, {
    repoUrl: "https://github.com/acme/duplicatejob",
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(asRecord(second.body.data).jobId, asRecord(first.body.data).jobId);
  assert.equal((await indexingJobStore.listRepositoryJobs("acme/duplicatejob")).length, 1);
});

test("duplicate validation errors are unchanged", async () => {
  const first = await call(TOKEN_A, { repoUrl: "https://gitlab.com/acme/demo" });
  const second = await call(TOKEN_A, { repoUrl: "https://gitlab.com/acme/demo" });

  assert.equal(first.status, 400);
  assert.equal(second.status, 400);
  assert.equal(first.body.error?.code, "validation_failed");
  assert.equal(second.body.error?.code, "validation_failed");
  assert.equal(first.body.error?.category, "validation");
  assert.equal(second.body.error?.category, "validation");
});

test("existing auth error contract is unchanged", async () => {
  const result = await call(undefined, {
    repoUrl: "https://github.com/acme/noauth",
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.error?.code, "unauthorized");
});

test("existing ownership error contract is unchanged", async () => {
  setRepositoryOwner("acme/private", USER_A.userId);

  const result = await call(TOKEN_B, {
    repoUrl: "https://github.com/acme/private",
  });

  assert.equal(result.status, 403);
  assert.equal(result.body.error?.code, "repo_not_owned");
  assert.equal(result.body.error?.message, "You do not have access to this repository.");
});
