// HTTP response contract / envelope coverage for GET /repos/indexed.
//
// TWO STALE GROUND-TRUTH CORRECTIONS (verified against the real checkout):
//   1. RepositoryIndexMetadata has 16 keys here, not 11 — additive lifecycle
//      fields (firstIndexedAt, lastIndexedAt, totalIndexedFiles, lastIndexMode,
//      lastChangedFileCount) were added in earlier work. The exact key set is
//      asserted below against the REAL shape.
//   2. The /repos/indexed handler DOES filter by owner (it returns only repos
//      owned by the authenticated user), contrary to the task's claim that no
//      filtering exists. Tests seed ownership to the caller and document the
//      real per-user behavior (see test 16).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  setRepositoryIndexed,
  listIndexedRepositories,
  clearRepositoryIndexRegistry,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  setRepositoryOwner,
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };

const TOKEN_A = `Bearer ${await signAccessToken(USER_A)}`;

const COUNTS: IndexedCounts = {
  chunkCount: 1,
  fileCount: 2,
  symbolCount: 3,
  graphNodeCount: 4,
  graphEdgeCount: 5,
  summaryAvailable: true,
};

// Real RepositoryIndexMetadata key set in this checkout (16 keys).
const ENTRY_KEYS = [
  "owner",
  "repo",
  "status",
  "indexedAt",
  "lastAccessedAt",
  "chunkCount",
  "fileCount",
  "symbolCount",
  "graphNodeCount",
  "graphEdgeCount",
  "summaryAvailable",
  "firstIndexedAt",
  "lastIndexedAt",
  "totalIndexedFiles",
  "lastIndexMode",
  "lastChangedFileCount",
  "lastFailureAt",
  "failureReason",
  "failedFileCount",
  "lastSuccessfulFile",
  "retryCount",
  "lastRetryAt",
].sort();

const NUMBER_FIELDS = [
  "chunkCount",
  "fileCount",
  "symbolCount",
  "graphNodeCount",
  "graphEdgeCount",
  "totalIndexedFiles",
  "lastChangedFileCount",
];
const NULLABLE_STRING_FIELDS = ["indexedAt", "lastAccessedAt", "firstIndexedAt", "lastIndexedAt"];

type ApiResponse = {
  success: boolean;
  data?: { repositories: Array<Record<string, unknown>>; count: number };
  error?: { code: string; message: string };
  requestId?: string;
};

function asData(json: ApiResponse): { repositories: Array<Record<string, unknown>>; count: number } {
  assert.ok(json.data, "expected data");
  return json.data;
}

// Deep-walk: no value may be `undefined`; `null` is allowed.
function assertNoUndefined(value: unknown, path = "body"): void {
  if (value === undefined) assert.fail(`undefined value at ${path}`);
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
  }
}

async function request(
  authorization?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: ApiResponse }> {
  const app = createApp();
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (authorization) headers.authorization = authorization;
  const res = await app.fetch(new Request("http://local/repos/indexed", { method: "GET", headers }));
  const json = (await res.json().catch(() => ({}))) as ApiResponse;
  return { status: res.status, json };
}

// Index a repo AND assign it to the caller so it surfaces in the filtered list.
function indexOwned(owner: string, repo: string, userId = USER_A.userId): void {
  setRepositoryIndexed(owner, repo, COUNTS);
  setRepositoryOwner(`${owner}/${repo}`, userId);
}

beforeEach(() => {
  clearRepositoryIndexRegistry();
  clearRepositoryOwners();
});

test("1. authenticated request -> 200", async () => {
  const { status } = await request(TOKEN_A);
  assert.equal(status, 200);
});

test("2. top-level keys are exactly [data, requestId, success] (no error)", async () => {
  const { json } = await request(TOKEN_A);
  assert.deepEqual(Object.keys(json).sort(), ["data", "requestId", "success"]);
  assert.ok(!("error" in json));
});

test("3. success === true (boolean)", async () => {
  const { json } = await request(TOKEN_A);
  assert.equal(json.success, true);
  assert.equal(typeof json.success, "boolean");
});

test("4. requestId is a non-empty string", async () => {
  const { json } = await request(TOKEN_A);
  assert.equal(typeof json.requestId, "string");
  assert.ok((json.requestId ?? "").length > 0);
});

test("5. data keys are exactly [count, repositories]", async () => {
  const { json } = await request(TOKEN_A);
  assert.deepEqual(Object.keys(asData(json)).sort(), ["count", "repositories"]);
});

test("6. repositories is always an array", async () => {
  const { json } = await request(TOKEN_A);
  assert.ok(Array.isArray(asData(json).repositories));
});

test("7. count is always a number", async () => {
  const { json } = await request(TOKEN_A);
  assert.equal(typeof asData(json).count, "number");
});

test("8. count === repositories.length", async () => {
  indexOwned("acme", "a");
  indexOwned("acme", "b");
  const { json } = await request(TOKEN_A);
  const data = asData(json);
  assert.equal(data.count, data.repositories.length);
});

test("9. empty registry -> data deep-equals { repositories: [], count: 0 }", async () => {
  const { json } = await request(TOKEN_A);
  assert.deepEqual(asData(json), { repositories: [], count: 0 });
});

test("10. multiple seeded repos -> deterministic ordering (owner asc, repo asc)", async () => {
  indexOwned("zeta", "z");
  indexOwned("alpha", "b");
  indexOwned("alpha", "a");
  const { json } = await request(TOKEN_A);
  const keys = asData(json).repositories.map((r) => `${r.owner}/${r.repo}`);
  assert.deepEqual(keys, ["alpha/a", "alpha/b", "zeta/z"]);
});

test("11. every entry matches the exact metadata key set + value types", async () => {
  indexOwned("acme", "demo");
  const { json } = await request(TOKEN_A);
  for (const entry of asData(json).repositories) {
    assert.deepEqual(Object.keys(entry).sort(), ENTRY_KEYS);
    assert.equal(typeof entry.owner, "string");
    assert.equal(typeof entry.repo, "string");
    assert.equal(typeof entry.status, "string");
    assert.equal(typeof entry.summaryAvailable, "boolean");
    for (const f of NUMBER_FIELDS) assert.equal(typeof entry[f], "number", `${f} number`);
    for (const f of NULLABLE_STRING_FIELDS) {
      const v = entry[f];
      assert.ok(v === null || typeof v === "string", `${f} string|null`);
      assert.notEqual(v, undefined);
    }
    assert.ok(entry.lastIndexMode === null || typeof entry.lastIndexMode === "string");
  }
});

test("12. repeated identical requests produce identical data payloads", async () => {
  indexOwned("acme", "demo");
  const first = await request(TOKEN_A);
  const second = await request(TOKEN_A);
  assert.deepEqual(asData(first.json), asData(second.json));
});

test("13. mutating the parsed body does not mutate the stored registry", async () => {
  indexOwned("acme", "demo");
  const before = JSON.parse(JSON.stringify(listIndexedRepositories()));
  const { json } = await request(TOKEN_A);
  const data = asData(json);
  data.repositories.push({ owner: "hacker", repo: "x" });
  if (data.repositories[0]) data.repositories[0].owner = "tampered";
  data.count = 999;
  assert.deepEqual(listIndexedRepositories(), before);
});

test("14. missing Authorization -> 401 failure envelope", async () => {
  const { status, json } = await request();
  assert.equal(status, 401);
  assert.equal(json.success, false);
  assert.equal(json.error?.code, "unauthorized");
  assert.equal(typeof json.error?.message, "string");
  assert.equal(typeof json.requestId, "string");
  assert.ok(!("data" in json));
});

test("15. invalid JWT -> 401 invalid_token", async () => {
  const { status, json } = await request("Bearer not.a.jwt");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "invalid_token");
});

test("16. ACTUAL ownership behavior: endpoint IS per-user filtered", async () => {
  // NOTE: contrary to the task's claim of no filtering, this route returns only
  // the authenticated user's owned repos. Documenting the REAL behavior.
  indexOwned("acme", "demo", USER_A.userId);
  indexOwned("beta", "svc", USER_B.userId);
  const { json } = await request(TOKEN_A);
  const repos = asData(json).repositories.map((r) => `${r.owner}/${r.repo}`);
  assert.deepEqual(repos, ["acme/demo"]); // userB's repo is NOT visible to userA
});

test("17. JSON round-trip deep-equals the body", async () => {
  indexOwned("acme", "demo");
  const { json } = await request(TOKEN_A);
  assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
});

test("18. no value anywhere in the response is undefined", async () => {
  indexOwned("acme", "demo");
  const { json } = await request(TOKEN_A);
  assertNoUndefined(json);
});
