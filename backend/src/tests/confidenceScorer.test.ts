import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreChunkConfidence,
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
    signals: {},
    ...overrides,
  };
}

test("1. empty input returns { confidence: 0, chunkCount: 0 }", () => {
  assert.deepEqual(scoreContextConfidence([]), { confidence: 0, chunkCount: 0 });
});

test("2. semantic-only chunk => semantic*0.35, other factors 0", () => {
  const c = scoreChunkConfidence(chunk({ signals: { semantic: 0.8 } }));
  assert.equal(c.confidence, 0.28); // 0.8 * 0.35
  assert.equal(c.factors.semantic, 0.8);
  assert.equal(c.factors.keyword, 0);
  assert.equal(c.factors.symbol, 0);
  assert.equal(c.factors.graph, 0);
  assert.equal(c.factors.fileSearch, 0);
});

test("3. keyword-only chunk => keyword*0.25", () => {
  const c = scoreChunkConfidence(chunk({ signals: { keyword: 0.6 } }));
  assert.equal(c.confidence, 0.15); // 0.6 * 0.25
});

test("4. mixed-signals chunk => correct weighted sum", () => {
  // 0.5*0.35 + 0.4*0.25 + 0.2*0.15 + 0.2*0.15 + 0.1*0.10
  // = 0.175 + 0.10 + 0.03 + 0.03 + 0.01 = 0.345
  const c = scoreChunkConfidence(
    chunk({ signals: { semantic: 0.5, keyword: 0.4, symbol: 0.2, graph: 0.2, fileSearch: 0.1 } }),
  );
  assert.equal(c.confidence, 0.345);
});

test("5. out-of-range signal is clamped, confidence never exceeds 1", () => {
  const c = scoreChunkConfidence(
    chunk({ signals: { semantic: 5, keyword: 5, symbol: 5, graph: 5, fileSearch: 5 } }),
  );
  assert.equal(c.confidence, 1); // all clamped to 1 -> weights sum to 1
  assert.equal(c.factors.semantic, 1);
});

test("6. deterministic: same chunk scored twice is deep-equal", () => {
  const input = chunk({ signals: { semantic: 0.7, graph: 0.3 } });
  assert.deepEqual(scoreChunkConfidence(input), scoreChunkConfidence(input));
});

test("7. context confidence equals rounded mean of per-chunk confidences", () => {
  const chunks = [
    chunk({ signals: { semantic: 0.8 } }), // 0.28
    chunk({ signals: { keyword: 0.6 } }), // 0.15
  ];
  // mean(0.28, 0.15) = 0.215
  assert.deepEqual(scoreContextConfidence(chunks), { confidence: 0.215, chunkCount: 2 });
});

test("8. stable repeated execution over an array", () => {
  const chunks = [
    chunk({ filePath: "a.ts", signals: { semantic: 0.5, keyword: 0.5 } }),
    chunk({ filePath: "b.ts", signals: { graph: 0.9 } }),
    chunk({ filePath: "c.ts", signals: { fileSearch: 0.4 } }),
  ];
  const a = scoreContextConfidence(chunks);
  const b = scoreContextConfidence(chunks);
  assert.deepEqual(a, b);
});

test("9. input chunk is not mutated", () => {
  const input = chunk({ signals: { semantic: 0.5 } });
  const snapshot = { ...input, signals: { ...input.signals } };
  scoreChunkConfidence(input);
  assert.deepEqual(input, snapshot);
});

test("10. missing signals treated as 0", () => {
  const c = scoreChunkConfidence(chunk({ signals: {} }));
  assert.equal(c.confidence, 0);
  assert.deepEqual(c.factors, {
    semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0,
  });
});
