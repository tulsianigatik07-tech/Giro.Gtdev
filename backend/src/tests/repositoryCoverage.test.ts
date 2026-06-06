import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryCoverage } from "../services/retrieval/repositoryCoverage.js";
import { buildRetrievalMetadata } from "../services/retrieval/retrievalMetadataExposure.js";
import type {
  EnrichedContextChunk,
  EnrichedAssembledContext,
} from "../services/context/contextTypes.js";

function chunk(overrides?: Partial<EnrichedContextChunk>): EnrichedContextChunk {
  return {
    filePath: "src/a.ts",
    language: "typescript",
    content: "const a = 1;",
    startLine: 1,
    endLine: 10,
    score: 0.5,
    source: "semantic",
    signals: { semantic: 0.5 },
    ...overrides,
  };
}

test("1. empty input returns zeroed coverage", () => {
  assert.deepEqual(buildRepositoryCoverage([]), {
    totalFilesRetrieved: 0,
    totalChunksRetrieved: 0,
    averageChunksPerFile: 0,
    dominantFile: undefined,
    dominantFileChunkCount: 0,
    fileDistribution: [],
  });
});

test("2. single file with multiple chunks", () => {
  const c = buildRepositoryCoverage([
    chunk({ filePath: "a.ts", startLine: 1 }),
    chunk({ filePath: "a.ts", startLine: 20 }),
  ]);
  assert.equal(c.totalFilesRetrieved, 1);
  assert.equal(c.totalChunksRetrieved, 2);
  assert.equal(c.dominantFile, "a.ts");
  assert.equal(c.dominantFileChunkCount, 2);
  assert.equal(c.fileDistribution[0]?.percentage, 100);
});

test("3. multiple files counted correctly", () => {
  const c = buildRepositoryCoverage([
    chunk({ filePath: "a.ts" }),
    chunk({ filePath: "b.ts" }),
    chunk({ filePath: "c.ts" }),
  ]);
  assert.equal(c.totalFilesRetrieved, 3);
  assert.equal(c.totalChunksRetrieved, 3);
});

test("4. dominant file selected correctly", () => {
  const c = buildRepositoryCoverage([
    chunk({ filePath: "low.ts", startLine: 1 }),
    chunk({ filePath: "high.ts", startLine: 1 }),
    chunk({ filePath: "high.ts", startLine: 20 }),
    chunk({ filePath: "high.ts", startLine: 40 }),
  ]);
  assert.equal(c.dominantFile, "high.ts");
  assert.equal(c.dominantFileChunkCount, 3);
});

test("5. dominant file alphabetical tiebreak", () => {
  // zebra and apple both have 1 chunk -> apple wins (alphabetically first)
  const c = buildRepositoryCoverage([
    chunk({ filePath: "zebra.ts" }),
    chunk({ filePath: "apple.ts" }),
  ]);
  assert.equal(c.dominantFile, "apple.ts");
  assert.equal(c.dominantFileChunkCount, 1);
});

test("6. percentage calculation correctness", () => {
  const c = buildRepositoryCoverage([
    chunk({ filePath: "a.ts", startLine: 1 }),
    chunk({ filePath: "a.ts", startLine: 20 }),
    chunk({ filePath: "a.ts", startLine: 40 }),
    chunk({ filePath: "b.ts", startLine: 1 }),
  ]);
  const a = c.fileDistribution.find((f) => f.filePath === "a.ts");
  const b = c.fileDistribution.find((f) => f.filePath === "b.ts");
  assert.equal(a?.percentage, 75); // 3/4
  assert.equal(b?.percentage, 25); // 1/4
});

test("7. percentage rounding to 3 decimals", () => {
  // 1/3 * 100 = 33.333...
  const c = buildRepositoryCoverage([
    chunk({ filePath: "a.ts", startLine: 1 }),
    chunk({ filePath: "b.ts", startLine: 1 }),
    chunk({ filePath: "c.ts", startLine: 1 }),
  ]);
  assert.equal(c.fileDistribution[0]?.percentage, 33.333);
});

test("8. averageChunksPerFile calculation", () => {
  // 5 chunks / 2 files = 2.5
  const c = buildRepositoryCoverage([
    chunk({ filePath: "a.ts", startLine: 1 }),
    chunk({ filePath: "a.ts", startLine: 20 }),
    chunk({ filePath: "a.ts", startLine: 40 }),
    chunk({ filePath: "b.ts", startLine: 1 }),
    chunk({ filePath: "b.ts", startLine: 20 }),
  ]);
  assert.equal(c.averageChunksPerFile, 2.5);
});

test("9. fileDistribution sorting (count desc, filePath asc)", () => {
  const c = buildRepositoryCoverage([
    chunk({ filePath: "b.ts", startLine: 1 }),
    chunk({ filePath: "a.ts", startLine: 1 }),
    chunk({ filePath: "a.ts", startLine: 20 }),
    chunk({ filePath: "c.ts", startLine: 1 }),
  ]);
  assert.deepEqual(
    c.fileDistribution.map((f) => f.filePath),
    ["a.ts", "b.ts", "c.ts"],
  );
});

test("10. deterministic repeated execution", () => {
  const input = [
    chunk({ filePath: "a.ts", startLine: 1 }),
    chunk({ filePath: "a.ts", startLine: 20 }),
    chunk({ filePath: "b.ts" }),
  ];
  assert.deepEqual(buildRepositoryCoverage(input), buildRepositoryCoverage(input));
});

test("11. input chunk array is not mutated", () => {
  const input = [chunk({ filePath: "a.ts" }), chunk({ filePath: "b.ts" })];
  const snapshot = input.map((c) => ({ ...c, signals: { ...c.signals } }));
  buildRepositoryCoverage(input);
  assert.deepEqual(input, snapshot);
});

test("12. exposure seam preserves repositoryCoverage exactly", () => {
  const repositoryCoverage = buildRepositoryCoverage([chunk({ filePath: "a.ts" })]);
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 1,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 1,
    sourceCounts: { semantic: 1, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
    repositoryCoverage,
  };
  const meta = buildRetrievalMetadata(stats);
  assert.deepEqual(meta.repositoryCoverage, repositoryCoverage);
});

test("13. exposure omits repositoryCoverage when absent (backward compatible)", () => {
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 0,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 0,
    sourceCounts: { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
  };
  const meta = buildRetrievalMetadata(stats);
  assert.ok(!("repositoryCoverage" in meta));
});
