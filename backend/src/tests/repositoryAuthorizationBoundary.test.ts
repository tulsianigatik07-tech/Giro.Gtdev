import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";

import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { authorizeIndexingJob } from "../services/indexing/jobs/indexingJobWorker.js";
import { authorizeRepository } from "../services/repository/ownershipGuard.js";
import { MemoryRepositoryStore } from "../services/repository/store/memoryRepositoryStore.js";
import { clearRepositoryOwners, setRepositoryOwner } from "../services/repository/ownershipStore.js";
import { normalizeGitHubRepositoryReference, normalizeRepositoryId } from "../services/security/repositoryIdentity.js";

const OWNER = { userId: "security-owner", email: "owner@example.com" };
const OTHER = { userId: "security-other", email: "other@example.com" };
const OTHER_TOKEN = `Bearer ${await signAccessToken(OTHER)}`;

test("canonical repository authorization returns a trusted context for the owner", async () => {
  const store = new MemoryRepositoryStore();
  await store.connectRepository({ owner: "acme", repo: "demo", ownerUserId: OWNER.userId });
  await store.markIndexed("acme/demo", {
    counts: { chunkCount: 1, fileCount: 1, symbolCount: 1, graphNodeCount: 1, graphEdgeCount: 0, summaryAvailable: true },
    indexedRevision: "a".repeat(40),
  });
  const result = await authorizeRepository({ repositoryId: "acme/demo", userId: OWNER.userId, store });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    Object.keys(result.repository).sort(),
    ["authenticatedUserId", "checkoutKey", "checkoutPath", "indexedRevision", "lifecycleState", "owner", "repo", "repositoryId"],
  );
  assert.equal(result.repository.repositoryId, "acme/demo");
  assert.match(result.repository.checkoutKey, /^repo-[0-9a-f]{64}$/);
});

test("canonical repository authorization distinguishes forbidden and absent records", async () => {
  const store = new MemoryRepositoryStore();
  await store.connectRepository({ owner: "acme", repo: "demo", ownerUserId: OWNER.userId });
  const forbidden = await authorizeRepository({ repositoryId: "acme/demo", userId: OTHER.userId, store });
  const absent = await authorizeRepository({ repositoryId: "acme/missing", userId: OWNER.userId, store });
  assert.deepEqual(forbidden.ok ? null : { status: forbidden.status, code: forbidden.code }, { status: 403, code: "repo_not_owned" });
  assert.deepEqual(absent.ok ? null : { status: absent.status, code: absent.code }, { status: 404, code: "repo_not_connected" });
});

test("repository identity variants normalize consistently while durable segment casing remains intentional", () => {
  const variants = [
    "https://github.com/Acme/Demo",
    "https://GITHUB.COM/Acme/Demo.git/",
    "git@GitHub.com:Acme/Demo.git",
    "github.com/Acme/Demo",
  ].map((value) => normalizeGitHubRepositoryReference(value).repositoryId);
  assert.deepEqual(variants, ["Acme/Demo", "Acme/Demo", "Acme/Demo", "Acme/Demo"]);
  assert.equal(normalizeRepositoryId("Acme/Demo").repositoryId, "Acme/Demo");
  assert.notEqual(normalizeRepositoryId("Acme/Demo").repositoryId, normalizeRepositoryId("acme/demo").repositoryId);
  for (const malformed of ["acme%2Fother/demo", "acme∕demo", "acme/demo/other", "acme/../demo"]) {
    assert.throws(() => normalizeRepositoryId(malformed));
  }
});

test("worker accepts only a durable job whose repository, owner, and URL all match", async () => {
  const repositories = new MemoryRepositoryStore();
  await repositories.connectRepository({ owner: "acme", repo: "demo", ownerUserId: OWNER.userId });
  const jobs = new MemoryIndexingJobStore();
  const valid = await jobs.createJob({
    repositoryId: "acme/demo",
    ownerUserId: OWNER.userId,
    repositoryOwner: "acme",
    repositoryName: "demo",
    repositoryUrl: "https://github.com/acme/demo.git",
  });
  assert.equal((await authorizeIndexingJob(valid, repositories)).repositoryId, "acme/demo");

  for (const mutation of [
    { repositoryName: "other" },
    { ownerUserId: OTHER.userId },
    { repositoryUrl: "https://github.com/acme/other" },
    { repositoryId: "acme/other" },
  ]) {
    await assert.rejects(authorizeIndexingJob({ ...valid, ...mutation }, repositories), /job\/repository mismatch/i);
  }
});

test("worker rejects jobs for deleted or disconnected durable repositories", async () => {
  const repositories = new MemoryRepositoryStore();
  await repositories.connectRepository({ owner: "acme", repo: "demo", ownerUserId: OWNER.userId });
  const jobs = new MemoryIndexingJobStore();
  const job = await jobs.createJob({
    repositoryId: "acme/demo",
    ownerUserId: OWNER.userId,
    repositoryOwner: "acme",
    repositoryName: "demo",
    repositoryUrl: "https://github.com/acme/demo",
  });
  await repositories.deleteRepository("acme/demo");
  await assert.rejects(authorizeIndexingJob(job, repositories), /job\/repository mismatch/i);
  await repositories.connectRepository({ owner: "acme", repo: "demo", ownerUserId: null });
  await assert.rejects(authorizeIndexingJob(job, repositories), /job\/repository mismatch/i);
});

test("architecture, context assembly, reindex, deletion, and file tools cannot cross ownership", async () => {
  clearRepositoryOwners();
  setRepositoryOwner("acme/demo", OWNER.userId);
  const app = createApp();
  const cases: Array<[string, string, unknown]> = [
    ["POST", "/architecture/review", { repositoryId: "acme/demo" }],
    ["POST", "/context/assemble", { query: "security", owner: "acme", repo: "demo" }],
    ["POST", "/tools/read-file", { repositoryId: "acme/demo", relativePath: "README.md" }],
    ["POST", "/repos/connect", { repoUrl: "https://github.com/acme/demo" }],
  ];
  for (const [method, url, body] of cases) {
    const response = await app.request(url, {
      method,
      headers: { authorization: OTHER_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 403, `${method} ${url}`);
  }
  const deleted = await app.request("/repos/acme/demo", { method: "DELETE", headers: { authorization: OTHER_TOKEN } });
  assert.equal(deleted.status, 403);
  const unauthenticated = await app.request("/architecture/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositoryId: "acme/demo" }),
  });
  assert.equal(unauthenticated.status, 401);
});

test("all repository-sensitive route modules use the canonical request/session guard and accept no checkout path", async () => {
  const sourceRoot = path.resolve("src/routes");
  const expectations: Record<string, string> = {
    "architecture.ts": "authorizeRepositoryRequest",
    "context.ts": "authorizeRepositoryRequest",
    "indexing.ts": "authorizeRepositoryRequest",
    "repositories.ts": "authorizeRepositoryRequest",
    "repositoryIndexingEvents.ts": "authorizeRepositoryRequest",
    "retrieval.ts": "authorizeRepositoryRequest",
    "search.ts": "authorizeRepositoryRequest",
    "sessions.ts": "authorizeSessionRepository",
    "tools.ts": "authorizeRepositoryRequest",
  };
  for (const [file, guard] of Object.entries(expectations)) {
    const source = await readFile(path.join(sourceRoot, file), "utf8");
    assert.equal(source.includes(guard), true, `${file} must use ${guard}`);
    assert.equal(/z\.object\(\{[^}]*\b(?:clonePath|checkoutPath)\s*:/.test(source), false, `${file} accepts a checkout path`);
  }
  const repositoriesSource = await readFile(path.join(sourceRoot, "repositories.ts"), "utf8");
  assert.match(repositoriesSource, /clonePath:\s*ctxAccess\.repository\.checkoutKey/);
  assert.equal(repositoriesSource.includes("clonePath: ctxAccess.repository.checkoutPath"), false);
});
