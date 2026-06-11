import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRetrievalDiversity } from "../services/retrieval/retrievalDiversity.js";
import { buildRetrievalMetadata } from "../services/retrieval/retrievalMetadataExposure.js";
import type {
  EnrichedContextChunk,
  EnrichedAssembledContext,
} from "../services/context/contextTypes.js";

let line = 0;
function chunk(filePath: string): EnrichedContextChunk {
  line += 1;
  return {
    filePath,
    language: "typescript",
    content: "x",
    startLine: line,
    endLine: line,
    score: 0.5,
    source: "semantic",
    signals: { semantic: 0.5 },
  };
}

function nChunks(filePath: string, n: number): EnrichedContextChunk[] {
  return Array.from({ length: n }, () => chunk(filePath));
}

test("1. empty input returns zeroed low-diversity object", () => {
  assert.deepEqual(buildRetrievalDiversity([]), {
    totalFiles: 0,
    totalChunks: 0,
    diversityScore: 0,
    concentrationScore: 0,
    classification: "low-diversity",
  });
});

test("2. single-file retrieval => low diversity, high concentration", () => {
  const d = buildRetrievalDiversity(nChunks("a.ts", 4));
  assert.equal(d.totalFiles, 1);
  assert.equal(d.totalChunks, 4);
  assert.equal(d.diversityScore, 0.25); // 1/4
  assert.equal(d.concentrationScore, 1); // 4/4
  assert.equal(d.classification, "low-diversity");
});

test("3. multi-file retrieval", () => {
  const d = buildRetrievalDiversity([chunk("a.ts"), chunk("b.ts"), chunk("c.ts")]);
  assert.equal(d.totalFiles, 3);
  assert.equal(d.totalChunks, 3);
});

test("4. diversityScore calculation correctness", () => {
  // 2 files / 4 chunks = 0.5
  const d = buildRetrievalDiversity([...nChunks("a.ts", 3), ...nChunks("b.ts", 1)]);
  assert.equal(d.diversityScore, 0.5);
});

test("5. concentrationScore calculation correctness", () => {
  // largest file 3 / 4 chunks = 0.75
  const d = buildRetrievalDiversity([...nChunks("a.ts", 3), ...nChunks("b.ts", 1)]);
  assert.equal(d.concentrationScore, 0.75);
});

test("6. high-diversity classification (>= 0.75)", () => {
  // 4 files / 4 chunks = 1.0
  const d = buildRetrievalDiversity([chunk("a.ts"), chunk("b.ts"), chunk("c.ts"), chunk("d.ts")]);
  assert.equal(d.classification, "high-diversity");
});

test("7. medium-diversity classification (>= 0.40 and < 0.75)", () => {
  // 2 files / 4 chunks = 0.5
  const d = buildRetrievalDiversity([...nChunks("a.ts", 3), ...nChunks("b.ts", 1)]);
  assert.equal(d.classification, "medium-diversity");
});

test("8. low-diversity classification (< 0.40)", () => {
  // 1 file / 4 chunks = 0.25
  const d = buildRetrievalDiversity(nChunks("a.ts", 4));
  assert.equal(d.classification, "low-diversity");
});

test("9. rounding to 3 decimals", () => {
  // 1 file / 3 chunks = 0.333...
  const d = buildRetrievalDiversity(nChunks("a.ts", 3));
  assert.equal(d.diversityScore, 0.333);
  assert.equal(d.concentrationScore, 1);
});

test("10. deterministic repeated execution", () => {
  const input = [...nChunks("a.ts", 2), ...nChunks("b.ts", 1)];
  assert.deepEqual(buildRetrievalDiversity(input), buildRetrievalDiversity(input));
});

test("11. input chunk array is not mutated", () => {
  const input = [...nChunks("a.ts", 2), ...nChunks("b.ts", 1)];
  const snapshot = input.map((c) => ({ ...c, signals: { ...c.signals } }));
  buildRetrievalDiversity(input);
  assert.deepEqual(input, snapshot);
});

test("12. exposure seam preserves retrievalDiversity exactly", () => {
  const retrievalDiversity = buildRetrievalDiversity([chunk("a.ts"), chunk("b.ts")]);
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 1,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 2,
    sourceCounts: { semantic: 2, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
    retrievalDiversity,
  };
  const meta = buildRetrievalMetadata(stats);
  assert.deepEqual(meta.retrievalDiversity, retrievalDiversity);
});

test("13. exposure omits retrievalDiversity when absent (backward compatible)", () => {
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 0,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 0,
    sourceCounts: { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
  };
  const meta = buildRetrievalMetadata(stats);
  assert.ok(!("retrievalDiversity" in meta));
});
test("14. same file repeated chunks produce concentrated diversity", () => {
  const d = buildRetrievalDiversity([
    ...nChunks("src/session.ts", 4),
    chunk("src/auth.ts"),
  ]);

  assert.equal(d.totalFiles, 2);
  assert.equal(d.totalChunks, 5);
  assert.equal(d.diversityScore, 0.4);
  assert.equal(d.concentrationScore, 0.8);
  assert.equal(d.classification, "medium-diversity");
});
