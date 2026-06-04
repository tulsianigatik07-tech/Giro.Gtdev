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
    crossFileBoostedChunkCount: 0,
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

test("10. related file chunk is boosted by a high-score seed", () => {
  // Seed: src/session.ts (high score). Related (same dir + family): src/sessionService.ts.
  const related = rerankChunks(
    [
      chunk({ filePath: "src/session.ts", content: "seed", score: 100, startLine: 1, endLine: 5 }),
      chunk({ filePath: "src/sessionService.ts", content: "rel", score: 10, startLine: 1, endLine: 5 }),
    ],
    "nomatch",
  );
  // Compare against a run where the candidate is unrelated (different dir + family).
  const baseline = rerankChunks(
    [
      chunk({ filePath: "src/session.ts", content: "seed", score: 100, startLine: 1, endLine: 5 }),
      chunk({ filePath: "lib/unrelated.ts", content: "rel", score: 10, startLine: 1, endLine: 5 }),
    ],
    "nomatch",
  );
  const relScore = related.chunks.find((c) => c.filePath === "src/sessionService.ts")?.score ?? 0;
  const baseScore = baseline.chunks.find((c) => c.filePath === "lib/unrelated.ts")?.score ?? 0;
  assert.ok(relScore > baseScore);
  assert.equal(related.statistics.crossFileBoostedChunkCount, 1);
});

test("11. seed file does not boost its own chunks", () => {
  const { chunks, statistics } = rerankChunks(
    [
      chunk({ filePath: "src/session.ts", content: "seed", score: 100, startLine: 1, endLine: 5 }),
      chunk({ filePath: "src/session.ts", content: "seed2", score: 100, startLine: 20, endLine: 25 }),
    ],
    "nomatch",
  );
  // Both chunks belong to the seed file -> no cross-file boost applied.
  assert.equal(statistics.crossFileBoostedChunkCount, 0);
  assert.ok(chunks.every((c) => c.score <= 1));
});

test("12. cross-file boost capped at +0.16 via relatedFiles", () => {
  // 3 seeds all relate to target; 3 * 0.08 = 0.24 but capped at 0.16.
  // target score 70 -> norm 0.70 (below 0.75 seed threshold, so it is a
  // boost candidate, not a seed). 0.70 + 0.16 cap = 0.86.
  const chunks = [
    chunk({ filePath: "a.ts", content: "x", score: 100, startLine: 1, endLine: 5 }),
    chunk({ filePath: "b.ts", content: "x", score: 100, startLine: 1, endLine: 5 }),
    chunk({ filePath: "c.ts", content: "x", score: 100, startLine: 1, endLine: 5 }),
    chunk({ filePath: "target.ts", content: "x", score: 70, startLine: 1, endLine: 5 }),
  ];
  const relatedFiles = {
    "a.ts": ["target.ts"],
    "b.ts": ["target.ts"],
    "c.ts": ["target.ts"],
  };
  const { chunks: out } = rerankChunks(chunks, "nomatch", { relatedFiles });
  const target = out.find((c) => c.filePath === "target.ts")?.score ?? 0;
  assert.ok(Math.abs(target - 0.86) < 1e-9, `expected ~0.86 got ${target}`);
});

test("13. unrelated files unchanged by cross-file boosting", () => {
  const { chunks, statistics } = rerankChunks(
    [
      chunk({ filePath: "src/alpha.ts", content: "seed", score: 100, startLine: 1, endLine: 5 }),
      chunk({ filePath: "totally/different/zeta.ts", content: "x", score: 50, startLine: 1, endLine: 5 }),
    ],
    "nomatch",
  );
  // zeta is in a different dir and shares no family -> no boost.
  assert.equal(statistics.crossFileBoostedChunkCount, 0);
  const zeta = chunks.find((c) => c.filePath === "totally/different/zeta.ts")?.score ?? -1;
  assert.ok(Math.abs(zeta - 0.5) < 1e-9, `expected 0.5 got ${zeta}`);
});

test("14. cross-file boosting is deterministic", () => {
  const input = [
    chunk({ filePath: "src/session.ts", content: "seed", score: 100, startLine: 1, endLine: 5 }),
    chunk({ filePath: "src/sessionService.ts", content: "rel", score: 10, startLine: 1, endLine: 5 }),
    chunk({ filePath: "src/sessionStore.ts", content: "rel2", score: 10, startLine: 1, endLine: 5 }),
  ];
  const a = rerankChunks(input, "nomatch");
  const b = rerankChunks(input, "nomatch");
  assert.deepEqual(a, b);
});

test("15. relatedFiles only boosts candidates present in the chunk list", () => {
  const { statistics } = rerankChunks(
    [
      chunk({ filePath: "a.ts", content: "seed", score: 100, startLine: 1, endLine: 5 }),
      chunk({ filePath: "present.ts", content: "x", score: 20, startLine: 1, endLine: 5 }),
    ],
    "nomatch",
    { relatedFiles: { "a.ts": ["present.ts", "absent.ts"] } },
  );
  // Only present.ts is in the list -> exactly one cross-file boost.
  assert.equal(statistics.crossFileBoostedChunkCount, 1);
});
