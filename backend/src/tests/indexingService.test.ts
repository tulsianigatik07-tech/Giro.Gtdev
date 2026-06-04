import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearRepositoryIndexRegistry,
  getRepositoryIndexMetadata,
  setRepositoryIndexing,
  setRepositoryIndexed,
  setRepositoryFailed,
  markRepositoryStale,
  touchRepositoryAccess,
  listIndexedRepositories,
  isRepositoryHealthy,
  isRepositoryStale,
  type IndexedCounts,
} from "../services/repository/indexingService.js";

const COUNTS: IndexedCounts = {
  chunkCount: 5,
  fileCount: 3,
  symbolCount: 7,
  graphNodeCount: 2,
  graphEdgeCount: 1,
  summaryAvailable: true,
};

beforeEach(() => {
  clearRepositoryIndexRegistry();
});

test("1. empty registry", () => {
  assert.deepEqual(listIndexedRepositories(), []);
});

test("2. setRepositoryIndexing creates metadata", () => {
  setRepositoryIndexing("o", "r");
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.equal(meta?.status, "indexing");
  assert.equal(meta?.indexedAt, null);
});

test("3. setRepositoryIndexed marks indexed", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.equal(meta?.status, "indexed");
  assert.equal(meta?.chunkCount, 5);
  assert.notEqual(meta?.indexedAt, null);
});

test("4. indexed list excludes non-indexed repos", () => {
  setRepositoryIndexing("o", "indexing-repo");
  setRepositoryFailed("o", "failed-repo");
  setRepositoryIndexed("o", "indexed-repo", COUNTS);
  const list = listIndexedRepositories();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.repo, "indexed-repo");
});

test("5. indexed list sorting owner asc, repo asc", () => {
  setRepositoryIndexed("b", "y", COUNTS);
  setRepositoryIndexed("a", "z", COUNTS);
  setRepositoryIndexed("a", "a", COUNTS);
  const keys = listIndexedRepositories().map((m) => `${m.owner}/${m.repo}`);
  assert.deepEqual(keys, ["a/a", "a/z", "b/y"]);
});

test("6. failed state preserves counts", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  setRepositoryFailed("o", "r");
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.equal(meta?.status, "failed");
  assert.equal(meta?.chunkCount, 5);
  assert.notEqual(meta?.indexedAt, null);
});

test("7. stale repos excluded from indexed list", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  markRepositoryStale("o", "r");
  assert.deepEqual(listIndexedRepositories(), []);
});

test("8. touch access updates timestamp", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  touchRepositoryAccess("o", "r");
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.notEqual(meta?.lastAccessedAt, null);
});

test("9. stale/touch on missing repo is safe", () => {
  assert.doesNotThrow(() => markRepositoryStale("nope", "nope"));
  assert.doesNotThrow(() => touchRepositoryAccess("nope", "nope"));
  assert.equal(getRepositoryIndexMetadata("nope", "nope"), null);
});

test("10. isRepositoryHealthy", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  assert.equal(isRepositoryHealthy("o", "r"), true);
  setRepositoryIndexing("o", "r2");
  assert.equal(isRepositoryHealthy("o", "r2"), false);
});

test("11. isRepositoryStale", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  markRepositoryStale("o", "r");
  assert.equal(isRepositoryStale("o", "r"), true);
  assert.equal(isRepositoryStale("o", "missing"), false);
});

test("12. registry reset helper", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  clearRepositoryIndexRegistry();
  assert.deepEqual(listIndexedRepositories(), []);
  assert.equal(getRepositoryIndexMetadata("o", "r"), null);
});
