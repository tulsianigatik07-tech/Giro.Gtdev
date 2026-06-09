import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  setRepositoryIndexed,
  setRepositoryIndexing,
  setRepositoryFailed,
  markRepositoryStale,
  clearRepositoryIndexRegistry,
} from "../services/repository/indexingService.js";
import {
  setRepositoryOwner,
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";

const USER = { userId: "metadata-user", email: "meta@example.com" };
const TOKEN = `Bearer ${await signAccessToken(USER)}`;

const REQUIRED_FIELDS = [
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
] as const;

const COUNTS = {
  chunkCount: 1,
  fileCount: 2,
  symbolCount: 3,
  graphNodeCount: 4,
  graphEdgeCount: 5,
  summaryAvailable: true,
};

type IndexedResponse = {
  success: boolean;
  data?: { repositories: Array<Record<string, unknown>>; count: number };
  error?: { code: string; message: string };
  requestId: string;
};

function asData(json: IndexedResponse): { repositories: Array<Record<string, unknown>>; count: number } {
  assert.ok(json.data, "expected data");
  return json.data;
}

// Index a repo AND assign it to USER so it appears in the owner-filtered list.
function indexOwned(owner: string, repo: string): void {
  setRepositoryIndexed(owner, repo, COUNTS);
  setRepositoryOwner(`${owner}/${repo}`, USER.userId);
}

async function request(path: string, authorization?: string) {
  const app = createApp();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  const res = await app.request(path, { method: "GET", headers });
  const json = (await res.json().catch(() => ({}))) as IndexedResponse;
  return { status: res.status, json };
}

// Recursively assert no value in the structure is `undefined` (null allowed).
function assertNoUndefined(value: unknown, path = "data"): void {
  if (value === undefined) {
    assert.fail(`undefined value found at ${path}`);
  }
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
  }
}

beforeEach(() => {
  clearRepositoryIndexRegistry();
  clearRepositoryOwners();
});

test("1. success response shape", async () => {
  indexOwned("acme", "demo");
  const { status, json } = await request("/repos/indexed", TOKEN);
  assert.equal(status, 200);
  assert.equal(json.success, true);
  const data = asData(json);
  assert.ok(Array.isArray(data.repositories));
  assert.equal(typeof data.count, "number");
});

test("2. count === repositories.length", async () => {
  indexOwned("acme", "a");
  indexOwned("acme", "b");
  const { json } = await request("/repos/indexed", TOKEN);
  const data = asData(json);
  assert.equal(data.count, data.repositories.length);
  assert.equal(data.count, 2);
});

test("3. schema completeness: every entry has all required fields", async () => {
  indexOwned("acme", "demo");
  const { json } = await request("/repos/indexed", TOKEN);
  const data = asData(json);
  for (const entry of data.repositories) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in entry, `missing field ${field}`);
    }
  }
});

test("4. indexed-only filtering (indexing/failed/stale excluded)", async () => {
  indexOwned("acme", "indexed"); // status indexed + owned
  // indexing
  setRepositoryIndexing("acme", "pending");
  setRepositoryOwner("acme/pending", USER.userId);
  // failed
  setRepositoryFailed("acme", "broken");
  setRepositoryOwner("acme/broken", USER.userId);
  // stale (indexed then marked stale)
  setRepositoryIndexed("acme", "old", COUNTS);
  markRepositoryStale("acme", "old");
  setRepositoryOwner("acme/old", USER.userId);

  const { json } = await request("/repos/indexed", TOKEN);
  const data = asData(json);
  assert.equal(data.count, 1);
  assert.equal(data.repositories[0]?.repo, "indexed");
  assert.equal(data.repositories[0]?.status, "indexed");
});

test("5. deterministic ordering (owner asc, repo asc)", async () => {
  indexOwned("zeta", "z");
  indexOwned("alpha", "b");
  indexOwned("alpha", "a");
  const { json } = await request("/repos/indexed", TOKEN);
  const keys = asData(json).repositories.map((r) => `${r.owner}/${r.repo}`);
  assert.deepEqual(keys, ["alpha/a", "alpha/b", "zeta/z"]);
});

test("6. repeated request stability (deep-equal sans requestId)", async () => {
  indexOwned("acme", "a");
  indexOwned("beta", "b");
  const first = await request("/repos/indexed", TOKEN);
  const second = await request("/repos/indexed", TOKEN);
  assert.deepEqual(asData(first.json), asData(second.json));
});

test("7. zero-value metadata serializes successfully", async () => {
  setRepositoryIndexed("acme", "empty", {
    chunkCount: 0,
    fileCount: 0,
    symbolCount: 0,
    graphNodeCount: 0,
    graphEdgeCount: 0,
    summaryAvailable: false,
  });
  setRepositoryOwner("acme/empty", USER.userId);
  const { json } = await request("/repos/indexed", TOKEN);
  const entry = asData(json).repositories[0];
  assert.equal(entry?.chunkCount, 0);
  assert.equal(entry?.summaryAvailable, false);
});

test("8. no undefined values leak in data", async () => {
  indexOwned("acme", "demo");
  const { json } = await request("/repos/indexed", TOKEN);
  assertNoUndefined(asData(json));
});

test("9. JSON round-trip preserves structure", async () => {
  indexOwned("acme", "demo");
  const { json } = await request("/repos/indexed", TOKEN);
  const data = asData(json);
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
});

test("10. missing auth -> 401 unauthorized", async () => {
  const { status, json } = await request("/repos/indexed");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "unauthorized");
});

test("11. invalid JWT -> 401 invalid_token", async () => {
  const { status, json } = await request("/repos/indexed", "Bearer not.a.jwt");
  assert.equal(status, 401);
  assert.equal(json.error?.code, "invalid_token");
});

// --- GET /repos/:id/summary deterministic error contracts ---

test("12. malformed id -> 400 invalid_id", async () => {
  const { status, json } = await request("/repos/not-a-valid-id/summary", TOKEN);
  assert.equal(status, 400);
  assert.equal(json.error?.code, "invalid_id");
});

test("13. owned repo with no clone -> 404 repo_not_connected", async () => {
  // Register ownership (repoId owner/repo) so the ownership guard passes, but
  // never create a clone directory -> existsSync fails -> repo_not_connected.
  setRepositoryOwner("acme/demo", USER.userId);
  const { status, json } = await request("/repos/acme--demo/summary", TOKEN);
  assert.equal(status, 404);
  assert.equal(json.error?.code, "repo_not_connected");
});
