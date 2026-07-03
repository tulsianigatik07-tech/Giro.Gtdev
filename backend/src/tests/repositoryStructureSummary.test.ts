import test from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryStructureSummary } from "../services/repository/repositoryStructureSummary.js";
import type { RepositoryIndexMetadata } from "../services/repository/indexingTypes.js";

function meta(overrides?: Partial<RepositoryIndexMetadata>): RepositoryIndexMetadata {
  return {
    owner: "acme",
    repo: "demo",
    status: "indexed",
    indexedAt: "2020-01-01T00:00:00.000Z",
    lastAccessedAt: "2020-01-01T00:00:00.000Z",
    chunkCount: 10,
    fileCount: 5,
    symbolCount: 7,
    graphNodeCount: 3,
    graphEdgeCount: 2,
    summaryAvailable: true,
    firstIndexedAt: "2020-01-01T00:00:00.000Z",
    lastIndexedAt: "2020-01-01T00:00:00.000Z",
    totalIndexedFiles: 5,
    lastIndexMode: "full",
    lastChangedFileCount: 0,
    lastFailureAt: null,
    failureReason: null,
    failedFileCount: 0,
    lastSuccessfulFile: null,
    retryCount: 0,
    lastRetryAt: null,
    ...overrides,
    lastLifecycleSeverity: null,
lastReindexMode: null,
lastReindexReason: null,
  };
}

test("1. small repository classification (fileCount = 10)", () => {
  assert.equal(buildRepositoryStructureSummary(meta({ fileCount: 10 })).repositoryScale, "small");
});

test("2. medium repository classification (fileCount = 100)", () => {
  assert.equal(buildRepositoryStructureSummary(meta({ fileCount: 100 })).repositoryScale, "medium");
});

test("3. large repository classification (fileCount = 1000)", () => {
  assert.equal(buildRepositoryStructureSummary(meta({ fileCount: 1000 })).repositoryScale, "large");
});

test("4. boundary correctness: 49->small, 50->medium, 249->medium, 250->large", () => {
  assert.equal(buildRepositoryStructureSummary(meta({ fileCount: 49 })).repositoryScale, "small");
  assert.equal(buildRepositoryStructureSummary(meta({ fileCount: 50 })).repositoryScale, "medium");
  assert.equal(buildRepositoryStructureSummary(meta({ fileCount: 249 })).repositoryScale, "medium");
  assert.equal(buildRepositoryStructureSummary(meta({ fileCount: 250 })).repositoryScale, "large");
});

test("5. correct field mapping (all six mapped fields)", () => {
  const summary = buildRepositoryStructureSummary(
    meta({
      fileCount: 11,
      chunkCount: 22,
      symbolCount: 33,
      graphNodeCount: 44,
      graphEdgeCount: 55,
      summaryAvailable: true,
    }),
  );
  assert.equal(summary.totalFiles, 11);
  assert.equal(summary.totalChunks, 22);
  assert.equal(summary.totalSymbols, 33);
  assert.equal(summary.totalGraphNodes, 44);
  assert.equal(summary.totalGraphEdges, 55);
  assert.equal(summary.summaryAvailable, true);
});

test("6. summaryAvailable propagation (true and false)", () => {
  assert.equal(buildRepositoryStructureSummary(meta({ summaryAvailable: true })).summaryAvailable, true);
  assert.equal(buildRepositoryStructureSummary(meta({ summaryAvailable: false })).summaryAvailable, false);
});

test("7. determinism: repeated calls are deepEqual", () => {
  const input = meta({ fileCount: 120, chunkCount: 99 });
  assert.deepEqual(
    buildRepositoryStructureSummary(input),
    buildRepositoryStructureSummary(input),
  );
});

test("8. input immutability", () => {
  const input = meta({ fileCount: 300 });
  const snapshot = JSON.parse(JSON.stringify(input));
  buildRepositoryStructureSummary(input);
  assert.deepEqual(input, snapshot);
});

test("9. zero-value repository", () => {
  const summary = buildRepositoryStructureSummary(
    meta({
      fileCount: 0,
      chunkCount: 0,
      symbolCount: 0,
      graphNodeCount: 0,
      graphEdgeCount: 0,
      summaryAvailable: false,
    }),
  );
  assert.deepEqual(summary, {
    totalFiles: 0,
    totalChunks: 0,
    totalSymbols: 0,
    totalGraphNodes: 0,
    totalGraphEdges: 0,
    summaryAvailable: false,
    repositoryScale: "small",
  });
});

test("10. large-value repository maps through without error", () => {
  const summary = buildRepositoryStructureSummary(
    meta({
      fileCount: 1_000_000,
      chunkCount: 5_000_000,
      symbolCount: 9_000_000,
      graphNodeCount: 2_000_000,
      graphEdgeCount: 8_000_000,
    }),
  );
  assert.equal(summary.totalFiles, 1_000_000);
  assert.equal(summary.repositoryScale, "large");
});

test("11. output shape stability: exact expected keys, no extras", () => {
  const summary = buildRepositoryStructureSummary(meta());
  assert.deepEqual(Object.keys(summary).sort(), [
    "repositoryScale",
    "summaryAvailable",
    "totalChunks",
    "totalFiles",
    "totalGraphEdges",
    "totalGraphNodes",
    "totalSymbols",
  ]);
});
