import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRetrievalMetadata } from "../services/retrieval/retrievalMetadataExposure.js";
import type { EnrichedAssembledContext } from "../services/context/contextTypes.js";
import type { ChunkConfidence } from "../services/retrieval/confidenceScorer.js";
import type { RetrievalDebugReport } from "../services/retrieval/debugReport.js";
import type { AnswerProvenance } from "../services/retrieval/answerProvenance.js";
import type { RerankStatistics } from "../services/retrieval/qualityReranker.js";

type Stats = EnrichedAssembledContext["stats"];

const BASE_STATS: Stats = {
  hybridResults: 5,
  fileSearchResults: 2,
  deduplicatedCount: 1,
  finalCount: 4,
  sourceCounts: { semantic: 2, keyword: 1, symbol: 0, graph: 0, fileSearch: 1 },
};

const CHUNK_CONF: ChunkConfidence[] = [
  {
    filePath: "src/a.ts",
    startLine: 1,
    endLine: 10,
    confidence: 0.42,
    factors: { semantic: 0.5, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
  },
];

const DEBUG_REPORT: RetrievalDebugReport = {
  totalChunksBeforeRerank: 6,
  totalChunksAfterRerank: 4,
  totalChunksAfterBudget: 4,
  duplicateChunksRemoved: 1,
  boostedChunks: 2,
  crossFileBoostedChunks: 0,
  averageConfidence: 0.42,
  filesRepresented: 2,
  sourcesRepresented: ["keyword", "semantic"],
};

const PROVENANCE: AnswerProvenance = {
  files: [{ filePath: "src/a.ts", chunkCount: 3 }],
  totalFiles: 1,
  totalChunks: 3,
};

const RERANK: RerankStatistics = {
  originalChunkCount: 6,
  rerankedChunkCount: 4,
  duplicateChunksRemoved: 1,
  boostedChunkCount: 2,
  crossFileBoostedChunkCount: 0,
};

function fullStats(): Stats {
  return {
    ...BASE_STATS,
    confidence: 0.42,
    chunkConfidence: CHUNK_CONF,
    debugReport: DEBUG_REPORT,
    answerProvenance: PROVENANCE,
    rerank: RERANK,
  };
}

test("1. retrieval metadata is produced from stats", () => {
  const meta = buildRetrievalMetadata(fullStats());
  assert.ok(meta.confidence !== undefined);
  assert.ok(meta.debugReport !== undefined);
  assert.ok(meta.answerProvenance !== undefined);
});

test("2. confidence preserved exactly", () => {
  const meta = buildRetrievalMetadata(fullStats());
  assert.equal(meta.confidence, 0.42);
});

test("3. debugReport preserved exactly", () => {
  const meta = buildRetrievalMetadata(fullStats());
  assert.deepEqual(meta.debugReport, DEBUG_REPORT);
});

test("4. answerProvenance preserved exactly", () => {
  const meta = buildRetrievalMetadata(fullStats());
  assert.deepEqual(meta.answerProvenance, PROVENANCE);
});

test("5. unavailable fields are omitted safely (no undefined keys)", () => {
  const meta = buildRetrievalMetadata(BASE_STATS); // no optional fields present
  assert.deepEqual(meta, {});
  assert.ok(!("confidence" in meta));
  assert.ok(!("debugReport" in meta));
  assert.ok(!("rerank" in meta));
});

test("6. deterministic repeated execution", () => {
  const stats = fullStats();
  assert.deepEqual(buildRetrievalMetadata(stats), buildRetrievalMetadata(stats));
});

test("7. input stats object is not mutated", () => {
  const stats = fullStats();
  const snapshot = JSON.parse(JSON.stringify(stats));
  buildRetrievalMetadata(stats);
  assert.deepEqual(JSON.parse(JSON.stringify(stats)), snapshot);
});

test("8. partial availability includes only present keys", () => {
  const stats: Stats = { ...BASE_STATS, confidence: 0.5, rerank: RERANK };
  const meta = buildRetrievalMetadata(stats);
  assert.equal(meta.confidence, 0.5);
  assert.deepEqual(meta.rerank, RERANK);
  assert.ok(!("debugReport" in meta));
  assert.ok(!("answerProvenance" in meta));
  assert.ok(!("chunkConfidence" in meta));
});
