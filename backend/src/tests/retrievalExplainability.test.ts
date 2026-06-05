import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRetrievalExplainability } from "../services/retrieval/explainability.js";
import { buildRetrievalMetadata } from "../services/retrieval/retrievalMetadataExposure.js";
import type { EnrichedContextChunk } from "../services/context/contextTypes.js";
import type { EnrichedAssembledContext } from "../services/context/contextTypes.js";

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

test("1. empty input returns { chunks: [] }", () => {
  assert.deepEqual(buildRetrievalExplainability([]), { chunks: [] });
});

test("2. semantic signal => semantic-match", () => {
  const r = buildRetrievalExplainability([chunk({ signals: { semantic: 0.5 } })]);
  assert.ok(r.chunks[0]?.reasons.includes("semantic-match"));
});

test("3. keyword signal => keyword-match", () => {
  const r = buildRetrievalExplainability([chunk({ signals: { keyword: 0.5 } })]);
  assert.ok(r.chunks[0]?.reasons.includes("keyword-match"));
});

test("4. symbol signal => symbol-match", () => {
  const r = buildRetrievalExplainability([chunk({ signals: { symbol: 0.5 } })]);
  assert.ok(r.chunks[0]?.reasons.includes("symbol-match"));
});

test("5. graph signal => graph-match", () => {
  const r = buildRetrievalExplainability([chunk({ signals: { graph: 0.5 } })]);
  assert.ok(r.chunks[0]?.reasons.includes("graph-match"));
});

test("6. fileSearch signal => file-search-match", () => {
  const r = buildRetrievalExplainability([
    chunk({ source: "file-search", signals: { fileSearch: 0.5 } }),
  ]);
  assert.ok(r.chunks[0]?.reasons.includes("file-search-match"));
});

test("7. source-based label produced from chunk.source (graph => dependency-source)", () => {
  const r = buildRetrievalExplainability([chunk({ source: "graph", signals: {} })]);
  assert.ok(r.chunks[0]?.reasons.includes("dependency-source"));
});

test("8. duplicate explanation removal (no repeated labels)", () => {
  // semantic signal + semantic source -> only one semantic-match, no dupes overall
  const r = buildRetrievalExplainability([
    chunk({ source: "semantic", signals: { semantic: 0.9 } }),
  ]);
  const reasons = r.chunks[0]?.reasons ?? [];
  assert.equal(new Set(reasons).size, reasons.length);
});

test("9. reasons sorted alphabetically ascending", () => {
  const r = buildRetrievalExplainability([
    chunk({ source: "graph", signals: { semantic: 0.5, keyword: 0.5, graph: 0.5 } }),
  ]);
  const reasons = r.chunks[0]?.reasons ?? [];
  const sorted = [...reasons].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(reasons, sorted);
});

test("10. deterministic repeated execution", () => {
  const input = [
    chunk({ filePath: "a.ts", signals: { semantic: 0.7, keyword: 0.3 } }),
    chunk({ filePath: "b.ts", source: "graph", signals: { graph: 0.9 } }),
  ];
  assert.deepEqual(buildRetrievalExplainability(input), buildRetrievalExplainability(input));
});

test("11. input chunks are not mutated", () => {
  const input = [chunk({ signals: { semantic: 0.5 } })];
  const snapshot = input.map((c) => ({ ...c, signals: { ...c.signals } }));
  buildRetrievalExplainability(input);
  assert.deepEqual(input, snapshot);
});

test("12. exposure seam preserves explainability exactly", () => {
  const explainability = buildRetrievalExplainability([
    chunk({ filePath: "a.ts", signals: { semantic: 0.5 } }),
  ]);
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 1,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 1,
    sourceCounts: { semantic: 1, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
    explainability,
  };
  const meta = buildRetrievalMetadata(stats);
  assert.deepEqual(meta.explainability, explainability);
});

test("13. exposure omits explainability when absent (backward compatible)", () => {
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 0,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 0,
    sourceCounts: { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
  };
  const meta = buildRetrievalMetadata(stats);
  assert.ok(!("explainability" in meta));
});
