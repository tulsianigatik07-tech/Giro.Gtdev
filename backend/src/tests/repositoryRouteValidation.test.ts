import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { buildRepositoryConnectFailureError } from "../services/repository/cloneFailureClassifier.js";
import {
  clearRepositoryIndexRegistry,
  setRepositoryIndexed,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  clearRepositoryOwners,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

const INDEX_COUNTS: IndexedCounts = {
  chunkCount: 1,
  fileCount: 1,
  symbolCount: 1,
  graphNodeCount: 1,
  graphEdgeCount: 1,
  summaryAvailable: true,
};

type ApiResponse = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
    category?: string;
    status?: number;
    retryable?: boolean;
    details?: unknown;
  };
};

async function authHeader(user: typeof USER_A): Promise<string> {
  return `Bearer ${await signAccessToken(user)}`;
}

async function request(input: {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}): Promise<{ status: number; body: ApiResponse }> {
  const app = createApp({ indexingJobStore });
  const headers: Record<string, string> = {};
  if (input.token) headers.authorization = input.token;
  if (input.body !== undefined) headers["content-type"] = "application/json";

  const res = await app.request(input.path, {
    method: input.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const body = (await res.json().catch(() => ({}))) as ApiResponse;

  return { status: res.status, body };
}

beforeEach(async () => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
  await indexingJobStore.clear();
});

test("invalid owner param is rejected before ownership lookup", async () => {
  const result = await request({
    method: "GET",
    path: "/repos/dependencies/bad_owner/demo",
    token: await authHeader(USER_A),
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_failed");
  assert.equal(result.body.error?.category, "validation");
  assert.equal(result.body.error?.status, 400);
  assert.equal(result.body.error?.retryable, false);
});

test("invalid repo param is rejected before ownership lookup", async () => {
  const result = await request({
    method: "GET",
    path: "/repos/dependencies/acme/repo%20name",
    token: await authHeader(USER_A),
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_failed");
  assert.equal(result.body.error?.category, "validation");
});

test("invalid repository URL on connect is rejected", async () => {
  const result = await request({
    method: "POST",
    path: "/repos/connect",
    token: await authHeader(USER_A),
    body: { repoUrl: "https://gitlab.com/acme/demo" },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_failed");
  assert.equal(result.body.error?.category, "validation");
});

test("valid repository URL on connect returns queued indexing job", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  setRepositoryIndexed("acme", "demo", INDEX_COUNTS);

  const result = await request({
    method: "POST",
    path: "/repos/connect",
    token: await authHeader(USER_A),
    body: { repoUrl: "https://github.com/acme/demo" },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.data?.repositoryId, "acme/demo");
  assert.equal(typeof result.body.data?.jobId, "string");
  assert.equal(result.body.data?.status, "queued");
});

test("valid SSH repository URL on connect returns queued indexing job", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);
  setRepositoryIndexed("acme", "demo", INDEX_COUNTS);

  const result = await request({
    method: "POST",
    path: "/repos/connect",
    token: await authHeader(USER_A),
    body: { repoUrl: "git@github.com:acme/demo.git" },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.data?.repositoryId, "acme/demo");
  assert.equal(typeof result.body.data?.jobId, "string");
  assert.equal(result.body.data?.status, "queued");
});

test("clone repo not found maps to standardized repository error", () => {
  const error = buildRepositoryConnectFailureError(
    new Error("Clone failed: remote: Repository not found."),
    "acme/missing",
  );

  assert.equal(error.code, "repo_not_found");
  assert.equal(error.status, 404);
  assert.equal(error.category, "repository");
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, {
    repository: "acme/missing",
    failureType: "repo_not_found",
  });
});

test("private or inaccessible repo maps to non-retryable clone_failed", () => {
  const error = buildRepositoryConnectFailureError(
    new Error("Clone failed: fatal: could not read Username for 'https://github.com'"),
    "acme/private",
  );

  assert.equal(error.code, "clone_failed");
  assert.equal(error.status, 500);
  assert.equal(error.category, "repository");
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, {
    repository: "acme/private",
    failureType: "private_or_inaccessible",
  });
});

test("git executable failure maps to non-retryable clone_failed", () => {
  const error = buildRepositoryConnectFailureError(
    new Error("spawn git ENOENT"),
    "acme/demo",
  );

  assert.equal(error.code, "clone_failed");
  assert.equal(error.status, 500);
  assert.equal(error.category, "repository");
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, {
    repository: "acme/demo",
    failureType: "git_executable_failure",
  });
});

test("clone timeout maps to retryable clone_failed", () => {
  const error = buildRepositoryConnectFailureError(
    new Error("Clone failed: operation timed out"),
    "acme/slow",
  );

  assert.equal(error.code, "clone_failed");
  assert.equal(error.status, 500);
  assert.equal(error.category, "repository");
  assert.equal(error.retryable, true);
  assert.deepEqual(error.details, {
    repository: "acme/slow",
    failureType: "clone_timeout",
  });
});

test("destination already exists maps to non-retryable clone_failed", () => {
  const error = buildRepositoryConnectFailureError(
    new Error("fatal: destination path 'demo' already exists and is not an empty directory."),
    "acme/demo",
  );

  assert.equal(error.code, "clone_failed");
  assert.equal(error.status, 500);
  assert.equal(error.category, "repository");
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, {
    repository: "acme/demo",
    failureType: "destination_exists",
  });
});

test("unknown clone failure maps to retryable clone_failed", () => {
  const error = buildRepositoryConnectFailureError(
    new Error("Clone failed: unexpected transport failure"),
    "acme/demo",
  );

  assert.equal(error.code, "clone_failed");
  assert.equal(error.status, 500);
  assert.equal(error.category, "repository");
  assert.equal(error.retryable, true);
  assert.deepEqual(error.details, {
    repository: "acme/demo",
    failureType: "unknown_clone_failure",
  });
});

test("path traversal repo param is rejected", async () => {
  const result = await request({
    method: "GET",
    path: "/repos/acme--../summary",
    token: await authHeader(USER_A),
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_failed");
  assert.equal(result.body.error?.category, "validation");
});

test("empty question is rejected on session ask", async () => {
  const result = await request({
    method: "POST",
    path: "/sessions/session-1/ask",
    token: await authHeader(USER_A),
    body: { question: "   " },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_failed");
  assert.equal(result.body.error?.category, "validation");
});

test("oversized question is rejected on session ask", async () => {
  const result = await request({
    method: "POST",
    path: "/sessions/session-1/ask",
    token: await authHeader(USER_A),
    body: { question: "a".repeat(4001) },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_failed");
  assert.equal(result.body.error?.category, "validation");
});

test("existing 401 behavior is unchanged", async () => {
  const result = await request({
    method: "GET",
    path: "/repos/dependencies/acme/demo",
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.error?.code, "unauthorized");
});

test("existing 403 behavior is unchanged", async () => {
  setRepositoryOwner("acme/demo", USER_A.userId);

  const result = await request({
    method: "GET",
    path: "/repos/dependencies/acme/demo",
    token: await authHeader(USER_B),
  });

  assert.equal(result.status, 403);
  assert.equal(result.body.error?.code, "repo_not_owned");
});

test("existing 404 behavior is unchanged", async () => {
  const result = await request({
    method: "GET",
    path: "/repos/dependencies/acme/demo",
    token: await authHeader(USER_A),
  });

  assert.equal(result.status, 404);
  assert.equal(result.body.error?.code, "repo_not_connected");
});
