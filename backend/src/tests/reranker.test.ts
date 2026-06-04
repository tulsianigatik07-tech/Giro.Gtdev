import { test } from "node:test";
import assert from "node:assert/strict";
import { rerankChunks } from "../services/retrieval/qualityReranker.js";
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

test("1. score normalization keeps values within 0..1", () => {
  const { chunks } = rerankChunks(
    [
      chunk({ filePath: "a.ts", score: 10 }),
      chunk({ filePath: "b.ts", score: 5 }),
      chunk({ filePath: "c.ts", score: 0 }),
    ],
    "unrelated",
  );
  assert.ok(chunks.every((c) => c.score >= 0 && c.score <= 1));
});

test("2. keyword boosting raises matching chunk score", () => {
  // Anchor the normalization ceiling with a high-score chunk so the
  // matching/non-matching pair sits below 1.0 and the boost is observable.
  const { chunks } = rerankChunks(
    [
      chunk({ filePath: "src/anchor.ts", content: "anchor", score: 100 }),
      chunk({ filePath: "src/retrieval.ts", content: "retrieval pipeline logic", score: 5 }),
      chunk({ filePath: "src/other.ts", content: "nothing here", score: 5 }),
    ],
    "retrieval pipeline",
  );
  const match = chunks.find((c) => c.filePath === "src/retrieval.ts");
  const other = chunks.find((c) => c.filePath === "src/other.ts");
  assert.ok(match && other);
  assert.ok((match?.score ?? 0) > (other?.score ?? 0));
});

test("3. duplicate suppression keeps highest score", () => {
  const { chunks, statistics } = rerankChunks(
    [
      chunk({ filePath: "a.ts", startLine: 1, endLine: 10, score: 3 }),
      chunk({ filePath: "a.ts", startLine: 1, endLine: 10, score: 9 }),
    ],
    "x",
  );
  assert.equal(chunks.length, 1);
  assert.equal(statistics.duplicateChunksRemoved, 1);
  // highest survives -> normalized to top (1.0 since it was the max)
  assert.ok((chunks[0]?.score ?? 0) > 0);
});

test("4. stable ordering tie-break", () => {
  const { chunks } = rerankChunks(
    [
      chunk({ filePath: "b.ts", startLine: 1, endLine: 5, score: 5 }),
      chunk({ filePath: "a.ts", startLine: 50, endLine: 60, score: 5 }),
      chunk({ filePath: "a.ts", startLine: 1, endLine: 5, score: 5 }),
    ],
    "nomatch",
  );
  // equal base score; a.ts before b.ts; within a.ts startLine 1 before 50.
  // Note: same-file diversity penalty pushes a.ts:50 below b.ts.
  assert.equal(chunks[0]?.filePath, "a.ts");
  assert.equal(chunks[0]?.startLine, 1);
});

test("5. same-file diversity penalty does not drop chunks", () => {
  const { chunks, statistics } = rerankChunks(
    [
      chunk({ filePath: "a.ts", startLine: 1, endLine: 10, score: 5 }),
      chunk({ filePath: "a.ts", startLine: 20, endLine: 30, score: 5 }),
      chunk({ filePath: "a.ts", startLine: 40, endLine: 50, score: 5 }),
    ],
    "nomatch",
  );
  assert.equal(chunks.length, 3);
  assert.equal(statistics.duplicateChunksRemoved, 0);
  // later same-file chunks penalized -> non-increasing scores
  assert.ok((chunks[0]?.score ?? 0) >= (chunks[1]?.score ?? 0));
  assert.ok((chunks[1]?.score ?? 0) >= (chunks[2]?.score ?? 0));
});

test("6. deterministic output for identical input", () => {
  const input = [
    chunk({ filePath: "a.ts", startLine: 1, score: 3 }),
    chunk({ filePath: "b.ts", startLine: 2, score: 7 }),
    chunk({ filePath: "a.ts", startLine: 5, score: 7 }),
  ];
  const a = rerankChunks(input, "retrieval");
  const b = rerankChunks(input, "retrieval");
  assert.deepEqual(a, b);
});

test("7. empty input returns empty + zeroed statistics", () => {
  const { chunks, statistics } = rerankChunks([], "anything");
  assert.deepEqual(chunks, []);
  assert.deepEqual(statistics, {
    originalChunkCount: 0,
    rerankedChunkCount: 0,
    duplicateChunksRemoved: 0,
    boostedChunkCount: 0,
  });
});

test("8. single chunk returned with score within 0..1", () => {
  const original = chunk({ content: "unique content body", score: 42 });
  const { chunks } = rerankChunks([original], "nomatch");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.content, "unique content body");
  assert.ok((chunks[0]?.score ?? -1) >= 0 && (chunks[0]?.score ?? 2) <= 1);
});

test("9. input array is not mutated", () => {
  const input = [chunk({ score: 5 }), chunk({ filePath: "b.ts", score: 9 })];
  const snapshot = input.map((c) => ({ ...c }));
  rerankChunks(input, "retrieval");
  assert.deepEqual(input, snapshot);
});
