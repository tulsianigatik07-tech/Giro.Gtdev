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

test("14. initial indexing populates lifecycle metadata", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.notEqual(meta?.firstIndexedAt, null);
  assert.notEqual(meta?.lastIndexedAt, null);
  assert.equal(meta?.totalIndexedFiles, COUNTS.fileCount);
});

test("15. re-indexing preserves historical first index timestamp", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  const first = getRepositoryIndexMetadata("o", "r");
  const firstIndexedAt = first?.firstIndexedAt;
  assert.notEqual(firstIndexedAt, null);

  const updatedCounts: IndexedCounts = { ...COUNTS, fileCount: 42 };
  setRepositoryIndexed("o", "r", updatedCounts);
  const second = getRepositoryIndexMetadata("o", "r");

  // firstIndexedAt preserved across re-index
  assert.equal(second?.firstIndexedAt, firstIndexedAt);
  // lastIndexedAt refreshed to the most recent indexed timestamp
  assert.equal(second?.lastIndexedAt, second?.indexedAt);
  // totalIndexedFiles reflects the latest run
  assert.equal(second?.totalIndexedFiles, 42);
});

test("16. totalIndexedFiles mirrors supplied fileCount", () => {
  const customCounts: IndexedCounts = { ...COUNTS, fileCount: 99 };
  setRepositoryIndexed("o", "r", customCounts);
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.equal(meta?.totalIndexedFiles, 99);
});

test("17. fresh indexing state starts empty", () => {
  setRepositoryIndexing("o", "r");
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.equal(meta?.firstIndexedAt, null);
  assert.equal(meta?.lastIndexedAt, null);
  assert.equal(meta?.totalIndexedFiles, 0);
});

test("18. backward compatibility remains intact", () => {
  // IndexedCounts contract unchanged: all original fields still supplied/copied.
  setRepositoryIndexed("o", "r", COUNTS);
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.equal(meta?.chunkCount, COUNTS.chunkCount);
  assert.equal(meta?.fileCount, COUNTS.fileCount);
  assert.equal(meta?.symbolCount, COUNTS.symbolCount);
  assert.equal(meta?.graphNodeCount, COUNTS.graphNodeCount);
  assert.equal(meta?.graphEdgeCount, COUNTS.graphEdgeCount);
  assert.equal(meta?.summaryAvailable, COUNTS.summaryAvailable);

  // listIndexedRepositories filtering unchanged: only indexed entries.
  setRepositoryIndexing("o", "indexing-repo");
  setRepositoryFailed("o", "failed-repo");
  setRepositoryIndexed("o", "indexed-repo", COUNTS);
  markRepositoryStale("o", "stale-repo");
  const list = listIndexedRepositories();
  assert.ok(list.every((m) => m.status === "indexed"));

  // sorting unchanged: owner asc, repo asc.
  setRepositoryIndexed("b", "y", COUNTS);
  setRepositoryIndexed("a", "z", COUNTS);
  const keys = listIndexedRepositories().map((m) => `${m.owner}/${m.repo}`);
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});
