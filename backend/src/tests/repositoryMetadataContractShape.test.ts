// Repository metadata SHAPE / contract stability coverage.
//
// NOTE: The originating task described an 11-key RepositoryIndexMetadata. That
// is stale for this checkout — the type has since gained additive lifecycle
// fields (firstIndexedAt, lastIndexedAt, totalIndexedFiles, lastIndexMode,
// lastChangedFileCount). These tests lock the ACTUAL 16-key shape so future
// work cannot silently change the structure. A separate existing file
// (repositoryMetadataContract.test.ts) covers the /repos/indexed envelope and
// summary error contracts; this file focuses on shape/type/ownership and does
// not duplicate it.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  setRepositoryIndexed,
  setRepositoryIndexing,
  setRepositoryFailed,
  markRepositoryStale,
  getRepositoryIndexMetadata,
  listIndexedRepositories,
  clearRepositoryIndexRegistry,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  setRepositoryOwner,
  clearRepositoryOwners,
} from "../services/repository/ownershipStore.js";
import { requireRepositoryAccess } from "../services/repository/ownershipGuard.js";

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

// Actual current RepositoryIndexMetadata key set (16 keys).
const EXPECTED_KEYS = [
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

const TIMESTAMP_OR_NULL = new Set(["indexedAt", "lastAccessedAt", "firstIndexedAt", "lastIndexedAt"]);
const NUMBER_FIELDS = [
  "chunkCount",
  "fileCount",
  "symbolCount",
  "graphNodeCount",
  "graphEdgeCount",
  "totalIndexedFiles",
  "lastChangedFileCount",
] as const;

type IndexedResponse = {
  success: boolean;
  data?: { repositories: Array<Record<string, unknown>>; count: number };
  error?: { code: string; message: string };
};

// Deep-walk: no value may be `undefined`; `null` is allowed.
function assertNoUndefined(value: unknown, path = "meta"): void {
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

beforeEach(() => {
  clearRepositoryIndexRegistry();
  clearRepositoryOwners();
});

test("1. indexed metadata shape: exact key set", () => {
  setRepositoryIndexed("acme", "demo", COUNTS);
  const meta = getRepositoryIndexMetadata("acme", "demo");
  assert.ok(meta);
  assert.deepEqual(Object.keys(meta).sort(), EXPECTED_KEYS);
});

test("2. field types are stable", () => {
  setRepositoryIndexed("acme", "demo", COUNTS);
  const meta = getRepositoryIndexMetadata("acme", "demo");
  assert.ok(meta);
  assert.equal(typeof meta.owner, "string");
  assert.equal(typeof meta.repo, "string");
  assert.equal(typeof meta.status, "string");
  assert.equal(typeof meta.summaryAvailable, "boolean");
  for (const f of NUMBER_FIELDS) {
    assert.equal(typeof meta[f], "number", `${f} must be number`);
  }
  for (const f of TIMESTAMP_OR_NULL) {
    const v = (meta as unknown as Record<string, unknown>)[f];
    assert.ok(v === null || typeof v === "string", `${f} must be string|null`);
    assert.notEqual(v, undefined);
  }
  // lastIndexMode is a string union or null, never undefined.
  assert.ok(meta.lastIndexMode === null || typeof meta.lastIndexMode === "string");
});

test("3. status reflects the lifecycle call (deterministic flag)", () => {
  setRepositoryIndexing("acme", "a");
  assert.equal(getRepositoryIndexMetadata("acme", "a")?.status, "indexing");

  setRepositoryIndexed("acme", "b", COUNTS);
  assert.equal(getRepositoryIndexMetadata("acme", "b")?.status, "indexed");

  setRepositoryFailed("acme", "c");
  assert.equal(getRepositoryIndexMetadata("acme", "c")?.status, "failed");

  setRepositoryIndexed("acme", "d", COUNTS);
  markRepositoryStale("acme", "d");
  const status = getRepositoryIndexMetadata("acme", "d")?.status;
  assert.ok(status && ["indexing", "indexed", "failed", "stale"].includes(status));
  assert.equal(status, "stale");
});

test("4. identifier determinism: identity fields stable across reads", () => {
  setRepositoryIndexed("acme", "demo", COUNTS);
  const first = getRepositoryIndexMetadata("acme", "demo");
  const second = getRepositoryIndexMetadata("acme", "demo");
  assert.equal(first?.owner, "acme");
  assert.equal(first?.repo, "demo");
  assert.equal(`${first?.owner}/${first?.repo}`, "acme/demo");
  assert.equal(first?.owner, second?.owner);
  assert.equal(first?.repo, second?.repo);
});

test("5. no field is ever undefined (null allowed)", () => {
  setRepositoryIndexing("acme", "fresh"); // timestamps + lastIndexMode null here
  const meta = getRepositoryIndexMetadata("acme", "fresh");
  assert.ok(meta);
  assertNoUndefined(meta);
});

test("6. JSON round-trip preserves the metadata", () => {
  setRepositoryIndexed("acme", "demo", COUNTS);
  const meta = getRepositoryIndexMetadata("acme", "demo");
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta);
});

test("7. repeated reads with no writes are deepEqual", () => {
  setRepositoryIndexed("acme", "a", COUNTS);
  setRepositoryIndexed("beta", "b", COUNTS);
  assert.deepEqual(getRepositoryIndexMetadata("acme", "a"), getRepositoryIndexMetadata("acme", "a"));
  assert.deepEqual(listIndexedRepositories(), listIndexedRepositories());
});

test("8. reads do not mutate stored state (snapshot isolation)", () => {
  setRepositoryIndexed("acme", "demo", COUNTS);

  const meta = getRepositoryIndexMetadata("acme", "demo") as unknown as Record<string, unknown>;
  meta.chunkCount = 9999;
  meta.owner = "tampered";
  assert.equal(getRepositoryIndexMetadata("acme", "demo")?.chunkCount, COUNTS.chunkCount);
  assert.equal(getRepositoryIndexMetadata("acme", "demo")?.owner, "acme");

  const list = listIndexedRepositories();
  list.push({ ...(list[0] as object) } as never);
  if (list[0]) (list[0] as unknown as Record<string, unknown>).repo = "hacked";
  const fresh = listIndexedRepositories();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.repo, "demo");
});

test("9. listIndexedRepositories: ordering + indexed-only", () => {
  setRepositoryIndexed("zeta", "z", COUNTS);
  setRepositoryIndexed("alpha", "b", COUNTS);
  setRepositoryIndexed("alpha", "a", COUNTS);
  setRepositoryIndexing("acme", "pending");
  setRepositoryFailed("acme", "broken");
  setRepositoryIndexed("acme", "old", COUNTS);
  markRepositoryStale("acme", "old");

  const list = listIndexedRepositories();
  assert.ok(list.every((m) => m.status === "indexed"));
  assert.deepEqual(
    list.map((m) => `${m.owner}/${m.repo}`),
    ["alpha/a", "alpha/b", "zeta/z"],
  );
});

test("10. collection contract: array of full-shape entries; empty -> []", () => {
  assert.deepEqual(listIndexedRepositories(), []);
  setRepositoryIndexed("acme", "demo", COUNTS);
  const list = listIndexedRepositories();
  assert.ok(Array.isArray(list));
  for (const entry of list) {
    assert.deepEqual(Object.keys(entry).sort(), EXPECTED_KEYS);
  }
});

test("11. ownership contract: owner ok, other 403, unowned 404", () => {
  setRepositoryOwner("acme/demo", USER_A.userId);

  const owner = requireRepositoryAccess({ repoId: "acme/demo", userId: USER_A.userId });
  assert.equal(owner.ok, true);

  const other = requireRepositoryAccess({ repoId: "acme/demo", userId: USER_B.userId });
  assert.equal(other.ok, false);
  if (!other.ok) {
    assert.equal(other.status, 403);
    assert.equal(other.code, "repo_not_owned");
  }

  const unowned = requireRepositoryAccess({ repoId: "ghost/missing", userId: USER_A.userId });
  assert.equal(unowned.ok, false);
  if (!unowned.ok) {
    assert.equal(unowned.status, 404);
    assert.equal(unowned.code, "repo_not_connected");
  }
});

test("12. GET /repos/indexed envelope: success + count + shape", async () => {
  setRepositoryIndexed("acme", "demo", COUNTS);
  setRepositoryOwner("acme/demo", USER_A.userId);

  const app = createApp();
  const res = await app.request("/repos/indexed", {
    method: "GET",
    headers: { authorization: TOKEN_A },
  });
  const json = (await res.json().catch(() => ({}))) as IndexedResponse;
  assert.equal(res.status, 200);
  assert.equal(json.success, true);
  assert.ok(json.data);
  assert.equal(json.data.count, json.data.repositories.length);
  for (const entry of json.data.repositories) {
    assert.deepEqual(Object.keys(entry).sort(), EXPECTED_KEYS);
  }
});
