import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRetrievalBlindSpots } from "../services/retrieval/retrievalBlindSpots.js";
import { buildRetrievalMetadata } from "../services/retrieval/retrievalMetadataExposure.js";
import type {
  EnrichedContextChunk,
  EnrichedAssembledContext,
} from "../services/context/contextTypes.js";

type Source = EnrichedContextChunk["source"];

let line = 0;
function chunk(source: Source, filePath: string): EnrichedContextChunk {
  line += 1;
  return {
    filePath,
    language: "typescript",
    content: "x",
    startLine: line,
    endLine: line,
    score: 0.5,
    source,
    signals: {},
  };
}

const ALL_SOURCES: Source[] = ["semantic", "keyword", "symbol", "graph", "file-search"];
const ALL_EXTS = [".ts", ".tsx", ".js", ".jsx", ".json", ".md"];

// Builds N chunks covering all sources + all extensions (no blind spots).
function fullCoverage(n: number): EnrichedContextChunk[] {
  return Array.from({ length: n }, (_, i) => {
    const source = ALL_SOURCES[i % ALL_SOURCES.length] as Source;
    const ext = ALL_EXTS[i % ALL_EXTS.length] as string;
    return chunk(source, `f${i}${ext}`);
  });
}

test("1. empty input returns no blind spots", () => {
  assert.deepEqual(buildRetrievalBlindSpots([]), {
    blindSpots: [],
    blindSpotCount: 0,
    hasBlindSpots: false,
  });
});

test("2. fewer than 5 chunks returns no blind spots", () => {
  const chunks = [chunk("semantic", "a.ts"), chunk("keyword", "b.ts")];
  const r = buildRetrievalBlindSpots(chunks);
  assert.equal(r.hasBlindSpots, false);
  assert.equal(r.blindSpotCount, 0);
});

test("3. a missing source creates a blind spot (>= 5 chunks)", () => {
  // 6 chunks, all "semantic", all .ts -> missing keyword/symbol/graph/file-search
  const chunks = Array.from({ length: 6 }, (_, i) => chunk("semantic", `f${i}.ts`));
  const r = buildRetrievalBlindSpots(chunks);
  const sourceSpots = r.blindSpots.filter((b) => b.type === "source").map((b) => b.name);
  assert.deepEqual(sourceSpots.sort(), ["file-search", "graph", "keyword", "symbol"]);
});

test("4. a missing file extension creates a blind spot (>= 5 chunks)", () => {
  // 6 chunks, all .ts -> .tsx/.js/.jsx/.json/.md missing
  const chunks = Array.from({ length: 6 }, (_, i) => chunk("semantic", `f${i}.ts`));
  const r = buildRetrievalBlindSpots(chunks);
  const extSpots = r.blindSpots.filter((b) => b.type === "file-extension").map((b) => b.name);
  assert.deepEqual(extSpots.sort(), [".js", ".json", ".jsx", ".md", ".tsx"]);
});

test("5. high severity when totalChunks >= 10", () => {
  const chunks = Array.from({ length: 10 }, (_, i) => chunk("semantic", `f${i}.ts`));
  const r = buildRetrievalBlindSpots(chunks);
  assert.ok(r.blindSpots.length > 0);
  assert.ok(r.blindSpots.every((b) => b.severity === "high"));
});

test("6. medium severity when totalChunks in 5..9", () => {
  const chunks = Array.from({ length: 5 }, (_, i) => chunk("semantic", `f${i}.ts`));
  const r = buildRetrievalBlindSpots(chunks);
  assert.ok(r.blindSpots.length > 0);
  assert.ok(r.blindSpots.every((b) => b.severity === "medium"));
});

test("7. blindSpots sorted (severity, type asc, name asc)", () => {
  // 6 chunks all semantic+.ts: sources missing (4) + extensions missing (5),
  // all same severity (medium) -> type asc (file-extension < source), then name asc.
  const chunks = Array.from({ length: 6 }, (_, i) => chunk("semantic", `f${i}.ts`));
  const r = buildRetrievalBlindSpots(chunks);
  // first group: file-extension entries alphabetically, then source entries
  const types = r.blindSpots.map((b) => b.type);
  const firstSource = types.indexOf("source");
  const lastExt = types.lastIndexOf("file-extension");
  assert.ok(lastExt < firstSource, "file-extension entries must precede source entries");
  // within file-extension, names ascending
  const extNames = r.blindSpots.filter((b) => b.type === "file-extension").map((b) => b.name);
  assert.deepEqual(extNames, [...extNames].sort((a, b) => a.localeCompare(b)));
});

test("8. blindSpotCount correctness", () => {
  // all semantic + all .ts -> 4 source spots + 5 ext spots = 9
  const chunks = Array.from({ length: 6 }, (_, i) => chunk("semantic", `f${i}.ts`));
  const r = buildRetrievalBlindSpots(chunks);
  assert.equal(r.blindSpotCount, r.blindSpots.length);
  assert.equal(r.blindSpotCount, 9);
});

test("9. hasBlindSpots false when full coverage", () => {
  // 12 chunks covering all sources + all extensions -> no blind spots
  const r = buildRetrievalBlindSpots(fullCoverage(12));
  assert.equal(r.hasBlindSpots, false);
  assert.equal(r.blindSpotCount, 0);
});

test("10. deterministic repeated execution", () => {
  const input = Array.from({ length: 7 }, (_, i) => chunk("keyword", `f${i}.ts`));
  assert.deepEqual(buildRetrievalBlindSpots(input), buildRetrievalBlindSpots(input));
});

test("11. input chunk array is not mutated", () => {
  const input = Array.from({ length: 6 }, (_, i) => chunk("semantic", `f${i}.ts`));
  const snapshot = input.map((c) => ({ ...c, signals: { ...c.signals } }));
  buildRetrievalBlindSpots(input);
  assert.deepEqual(input, snapshot);
});

test("12. exposure seam preserves retrievalBlindSpots exactly", () => {
  const retrievalBlindSpots = buildRetrievalBlindSpots(
    Array.from({ length: 6 }, (_, i) => chunk("semantic", `f${i}.ts`)),
  );
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 1,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 6,
    sourceCounts: { semantic: 6, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
    retrievalBlindSpots,
  };
  const meta = buildRetrievalMetadata(stats);
  assert.deepEqual(meta.retrievalBlindSpots, retrievalBlindSpots);
});

test("13. exposure omits retrievalBlindSpots when absent (backward compatible)", () => {
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 0,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 0,
    sourceCounts: { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
  };
  const meta = buildRetrievalMetadata(stats);
  assert.ok(!("retrievalBlindSpots" in meta));
});

test("14. minimum full source and extension coverage has no blind spots", () => {
  const chunks: EnrichedContextChunk[] = [
    chunk("semantic", "a.ts"),
    chunk("keyword", "b.tsx"),
    chunk("symbol", "c.js"),
    chunk("graph", "d.jsx"),
    chunk("file-search", "e.json"),
    chunk("semantic", "f.md"),
  ];

  const r = buildRetrievalBlindSpots(chunks);

  assert.equal(r.hasBlindSpots, false);
  assert.equal(r.blindSpotCount, 0);
  assert.deepEqual(r.blindSpots, []);
});
