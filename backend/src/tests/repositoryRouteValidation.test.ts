import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  clearRepositoryIndexRegistry,
  setRepositoryIndexed,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  clearRepositoryOwners,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";

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
  const app = createApp();
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

beforeEach(() => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
});

test("invalid owner param is rejected before ownership lookup", async () => {
  const result = await request({
    method: "GET",
    path: "/repos/dependencies/bad_owner/demo",
    token: await authHeader(USER_A),
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_error");
});

test("invalid repo param is rejected before ownership lookup", async () => {
  const result = await request({
    method: "GET",
    path: "/repos/dependencies/acme/repo%20name",
    token: await authHeader(USER_A),
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_error");
});

test("invalid repository URL on connect is rejected", async () => {
  const result = await request({
    method: "POST",
    path: "/repos/connect",
    token: await authHeader(USER_A),
    body: { repoUrl: "https://gitlab.com/acme/demo" },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_error");
});

test("valid repository URL on connect still reaches existing success path", async () => {
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
  assert.equal(result.body.data?.skipped, true);
  assert.equal(result.body.data?.reason, "already_indexed");
});

test("path traversal repo param is rejected", async () => {
  const result = await request({
    method: "GET",
    path: "/repos/acme--../summary",
    token: await authHeader(USER_A),
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "invalid_id");
});

test("empty question is rejected on session ask", async () => {
  const result = await request({
    method: "POST",
    path: "/sessions/session-1/ask",
    token: await authHeader(USER_A),
    body: { question: "   " },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_error");
});

test("oversized question is rejected on session ask", async () => {
  const result = await request({
    method: "POST",
    path: "/sessions/session-1/ask",
    token: await authHeader(USER_A),
    body: { question: "a".repeat(4001) },
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error?.code, "validation_error");
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
