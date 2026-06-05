import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConfidenceMetadata,
  scoreContextConfidence,
} from "../services/retrieval/confidenceScorer.js";
import type { EnrichedContextChunk } from "../services/context/contextTypes.js";

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

// Simulates the enrichedAssembler stats object being augmented with confidence,
// using the same pure helper the assembler uses (no network/AI/DB).
function augmentStats(finalChunks: EnrichedContextChunk[]) {
  const existing = { finalCount: finalChunks.length, rerank: { boostedChunkCount: 0 } };
  const conf = buildConfidenceMetadata(finalChunks);
  return { ...existing, confidence: conf.confidence, chunkConfidence: conf.chunkConfidence };
}

test("1. metadata contains an overall confidence number", () => {
  const stats = augmentStats([chunk({ signals: { semantic: 0.8 } })]);
  assert.equal(typeof stats.confidence, "number");
});

test("2. metadata contains per-chunk chunkConfidence", () => {
  const stats = augmentStats([
    chunk({ filePath: "a.ts", signals: { semantic: 0.8 } }),
    chunk({ filePath: "b.ts", signals: { keyword: 0.4 } }),
  ]);
  assert.ok(Array.isArray(stats.chunkConfidence));
  assert.equal(stats.chunkConfidence.length, 2);
});

test("3. metadata.confidence equals scoreContextConfidence(finalChunks).confidence", () => {
  const finalChunks = [
    chunk({ filePath: "a.ts", signals: { semantic: 0.8 } }),
    chunk({ filePath: "b.ts", signals: { keyword: 0.6 } }),
  ];
  const stats = augmentStats(finalChunks);
  assert.equal(stats.confidence, scoreContextConfidence(finalChunks).confidence);
});

test("4. chunkConfidence length equals the final chunk count", () => {
  const finalChunks = [chunk({ filePath: "a.ts" }), chunk({ filePath: "b.ts" }), chunk({ filePath: "c.ts" })];
  const stats = augmentStats(finalChunks);
  assert.equal(stats.chunkConfidence.length, finalChunks.length);
});

test("5. deterministic repeated execution", () => {
  const finalChunks = [
    chunk({ filePath: "a.ts", signals: { semantic: 0.7, graph: 0.3 } }),
    chunk({ filePath: "b.ts", signals: { fileSearch: 0.9 } }),
  ];
  assert.deepEqual(augmentStats(finalChunks), augmentStats(finalChunks));
});

test("6. empty assembled context => confidence 0 and empty chunkConfidence", () => {
  const stats = augmentStats([]);
  assert.equal(stats.confidence, 0);
  assert.deepEqual(stats.chunkConfidence, []);
});

test("7. existing stats fields (rerank) preserved after adding confidence", () => {
  const stats = augmentStats([chunk({ signals: { semantic: 0.5 } })]);
  assert.ok("rerank" in stats);
  assert.equal(stats.finalCount, 1);
});

test("8. original final chunk array is not mutated", () => {
  const finalChunks = [chunk({ signals: { semantic: 0.5 } }), chunk({ filePath: "b.ts", signals: { keyword: 0.4 } })];
  const snapshot = finalChunks.map((c) => ({ ...c, signals: { ...c.signals } }));
  buildConfidenceMetadata(finalChunks);
  assert.deepEqual(finalChunks, snapshot);
});

test("9. chunkConfidence entries reference correct file + lines", () => {
  const finalChunks = [chunk({ filePath: "src/x.ts", startLine: 5, endLine: 20, signals: { semantic: 0.5 } })];
  const stats = augmentStats(finalChunks);
  const first = stats.chunkConfidence[0];
  assert.equal(first?.filePath, "src/x.ts");
  assert.equal(first?.startLine, 5);
  assert.equal(first?.endLine, 20);
});
