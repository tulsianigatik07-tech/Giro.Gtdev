// Route-level repository isolation coverage: proves one authenticated user
// cannot reach another user's repository data, and that auth runs before the
// ownership gate. Test-only; exercises ONLY deterministic auth/ownership/
// validation paths that run before any clone/FS/Supabase work.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  setRepositoryIndexed,
  listIndexedRepositories,
  getRepositoryIndexMetadata,
  clearRepositoryIndexRegistry,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  setRepositoryOwner,
  getRepositoryOwner,
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

const TOKEN_A = `Bearer ${await signAccessToken(USER_A)}`;
const TOKEN_B = `Bearer ${await signAccessToken(USER_B)}`;

const COUNTS: IndexedCounts = {
  chunkCount: 1,
  fileCount: 2,
  symbolCount: 3,
  graphNodeCount: 4,
  graphEdgeCount: 5,
  summaryAvailable: true,
};

type ApiResponse = {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  requestId?: string;
};

function asRecord(v: unknown): Record<string, unknown> {
  assert.ok(v && typeof v === "object", "expected object");
  return v as Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  authorization?: string,
  body?: unknown,
): Promise<{ status: number; json: ApiResponse }> {
  const app = createApp({ indexingJobStore });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  const res = await app.fetch(
    new Request("http://local" + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  const json = (await res.json().catch(() => ({}))) as ApiResponse;
  return { status: res.status, json };
}

// Protected routes that run auth -> ownership gate before any clone/FS work.
const REPO_URL = "https://github.com/acme/demo";
const owned = () => setRepositoryOwner("acme/demo", USER_A.userId);

async function context(token?: string) {
  return call("POST", "/repos/context", token, { repoUrl: REPO_URL });
}
async function summary(token?: string) {
  return call("GET", "/repos/acme--demo/summary", token);
}
async function dependencies(token?: string) {
  return call("GET", "/repos/dependencies/acme/demo", token);
}
async function search(token?: string) {
  return call("GET", "/repos/search/acme/demo?q=foo", token);
}

beforeEach(async () => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
  await indexingJobStore.clear();
});

// --- 1 & 2: auth runs before everything ---
test("1. missing Authorization -> 401 unauthorized", async () => {
  const { status, json } = await call("GET", "/repos/indexed");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("2. invalid JWT -> 401 invalid_token", async () => {
  const { status, json } = await call("GET", "/repos/indexed", "Bearer garbage.token");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "invalid_token");
});

// --- 3: owner passes the ownership gate (stopped only at missing clone) ---
test("3a. connect: owner + healthy index -> 200 queued job", async () => {
  owned();
  setRepositoryIndexed("acme", "demo", COUNTS); // makes index healthy
  const { status, json } = await call("POST", "/repos/connect", TOKEN_A, { repoUrl: REPO_URL });
  assert.equal(status, 200);
  assert.equal(asRecord(json.data).repositoryId, "acme/demo");
  assert.equal(typeof asRecord(json.data).jobId, "string");
  assert.equal(asRecord(json.data).status, "queued");
});

test("3b. owner passes gate on context/summary/dependencies/search -> 404 repo_not_connected", async () => {
  owned();
  for (const res of [await context(TOKEN_A), await summary(TOKEN_A), await dependencies(TOKEN_A), await search(TOKEN_A)]) {
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 403);
    assert.equal(res.status, 404);
    assert.equal(res.json.error?.code, "repo_not_connected");
  }
});

// --- 4: foreign user blocked at ownership gate ---
test("4a. connect: foreign user -> 403 repo_not_owned", async () => {
  owned();
  setRepositoryIndexed("acme", "demo", COUNTS);
  const { status, json } = await call("POST", "/repos/connect", TOKEN_B, { repoUrl: REPO_URL });
  assert.equal(status, 403);
  assert.equal(json.error?.code, "repo_not_owned");
});

test("4b. foreign user -> 403 repo_not_owned on context/summary/dependencies/search", async () => {
  owned();
  for (const res of [await context(TOKEN_B), await summary(TOKEN_B), await dependencies(TOKEN_B), await search(TOKEN_B)]) {
    assert.equal(res.status, 403);
    assert.equal(res.json.error?.code, "repo_not_owned");
  }
});

// --- 5: no owner record -> guard's not-connected result ---
test("5. no owner record -> 404 repo_not_connected on context/summary/dependencies/search", async () => {
  for (const res of [await context(TOKEN_A), await summary(TOKEN_A), await dependencies(TOKEN_A), await search(TOKEN_A)]) {
    assert.equal(res.status, 404);
    assert.equal(res.json.error?.code, "repo_not_connected");
  }
});

// --- 6: /repos/indexed returns the caller's indexed repos for a valid JWT ---
// NOTE: contrary to the task's stated "no ownership filter", this route DOES
// filter listIndexedRepositories() to repos owned by the authenticated user.
// Asserting the real behavior.
test("6. GET /repos/indexed returns owned indexed repos for a valid JWT (no 401/403)", async () => {
  setRepositoryIndexed("acme", "demo", COUNTS);
  setRepositoryIndexed("beta", "svc", COUNTS);
  setRepositoryOwner("acme/demo", USER_A.userId);
  setRepositoryOwner("beta/svc", USER_A.userId);
  const { status, json } = await call("GET", "/repos/indexed", TOKEN_A);
  assert.equal(status, 200);
  assert.equal(json.success, true);
  const data = asRecord(json.data);
  assert.ok(Array.isArray(data.repositories));
  assert.equal(data.count, (data.repositories as unknown[]).length);
  assert.equal((data.repositories as unknown[]).length, 2);
});

// --- 7: determinism of rejection responses ---
test("7. repeated unauthorized/forbidden requests return identical status+code", async () => {
  const u1 = await call("GET", "/repos/indexed");
  const u2 = await call("GET", "/repos/indexed");
  assert.equal(u1.status, u2.status);
  assert.equal(u1.json.error?.code, u2.json.error?.code);

  owned();
  const f1 = await dependencies(TOKEN_B);
  const f2 = await dependencies(TOKEN_B);
  assert.equal(f1.status, f2.status);
  assert.equal(f1.json.error?.code, f2.json.error?.code);
  assert.equal(f1.status, 403);
  assert.equal(f1.json.error?.code, "repo_not_owned");
});

// --- 8: failed access does not mutate ownership store ---
test("8. failed access attempts do not mutate ownership store", async () => {
  owned();
  const before = getRepositoryOwner("acme/demo");
  await context(TOKEN_B); // 403
  await summary(TOKEN_B); // 403
  await dependencies(TOKEN_B); // 403
  await search(TOKEN_B); // 403
  const after = getRepositoryOwner("acme/demo");
  assert.equal(after, before);
  assert.equal(after, USER_A.userId);
});

// --- 9: failed access does not mutate index registry ---
test("9. failed access attempts do not mutate the index registry", async () => {
  owned();
  setRepositoryIndexed("acme", "demo", COUNTS);
  const listBefore = JSON.parse(JSON.stringify(listIndexedRepositories()));
  const metaBefore = JSON.parse(JSON.stringify(getRepositoryIndexMetadata("acme", "demo")));

  await call("POST", "/repos/connect", TOKEN_B, { repoUrl: REPO_URL }); // 403
  await context(TOKEN_B);
  await dependencies(TOKEN_B);

  assert.deepEqual(listIndexedRepositories(), listBefore);
  assert.deepEqual(getRepositoryIndexMetadata("acme", "demo"), metaBefore);
});

// --- 10: valid JWT reaches ownership check (never 401) ---
test("10. valid JWT reaches ownership check, not auth failure", async () => {
  owned();
  for (const res of [await context(TOKEN_A), await dependencies(TOKEN_B)]) {
    assert.notEqual(res.status, 401);
    assert.ok(res.status === 403 || res.status === 404);
  }
});

// --- validation rejections that prove auth/ownership ordering ---
test("11. summary invalid id -> 400 validation_failed (with valid JWT)", async () => {
  const { status, json } = await call("GET", "/repos/not-a-valid-id/summary", TOKEN_A);
  assert.equal(status, 400);
  assert.equal(json.error?.code, "validation_failed");
});

test("12. search missing q -> 400 validation_failed (with valid JWT)", async () => {
  const { status, json } = await call("GET", "/repos/search/acme/demo", TOKEN_A);
  assert.equal(status, 400);
  assert.equal(json.error?.code, "validation_failed");
});
