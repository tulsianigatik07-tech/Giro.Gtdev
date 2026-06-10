import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRetrievalHotspots } from "../services/retrieval/retrievalHotspots.js";
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

// Build N chunks for a file (unique line numbers via the counter).
function nChunks(filePath: string, n: number): EnrichedContextChunk[] {
  return Array.from({ length: n }, () => chunk(filePath));
}

test("1. empty input returns balanced zeroed hotspots", () => {
  assert.deepEqual(buildRetrievalHotspots([]), {
    hotspotFiles: [],
    hotspotCount: 0,
    dominantHotspot: undefined,
    concentrationLevel: "balanced",
  });
});

test("2. no hotspots when all files below 20%", () => {
  // 10 files * 1 chunk each = 10% each -> none >= 20%
  const chunks = Array.from({ length: 10 }, (_, i) => chunk(`f${i}.ts`));
  const h = buildRetrievalHotspots(chunks);
  assert.equal(h.hotspotCount, 0);
  assert.equal(h.concentrationLevel, "balanced");
});

test("3. low hotspot when >= 20 and < 30", () => {
  // a.ts = 2/10 = 20% (low); rest 8 singletons at 10%
  const chunks = [...nChunks("a.ts", 2), ...Array.from({ length: 8 }, (_, i) => chunk(`f${i}.ts`))];
  const h = buildRetrievalHotspots(chunks);
  const a = h.hotspotFiles.find((f) => f.filePath === "a.ts");
  assert.equal(a?.severity, "low");
  assert.equal(a?.percentage, 20);
});

test("4. medium hotspot when >= 30 and < 50", () => {
  // a.ts = 3/10 = 30% (medium)
  const chunks = [...nChunks("a.ts", 3), ...Array.from({ length: 7 }, (_, i) => chunk(`f${i}.ts`))];
  const a = buildRetrievalHotspots(chunks).hotspotFiles.find((f) => f.filePath === "a.ts");
  assert.equal(a?.severity, "medium");
  assert.equal(a?.percentage, 30);
});

test("5. high hotspot when >= 50", () => {
  // a.ts = 5/10 = 50% (high)
  const chunks = [...nChunks("a.ts", 5), ...Array.from({ length: 5 }, (_, i) => chunk(`f${i}.ts`))];
  const a = buildRetrievalHotspots(chunks).hotspotFiles.find((f) => f.filePath === "a.ts");
  assert.equal(a?.severity, "high");
  assert.equal(a?.percentage, 50);
});

test("6. dominantHotspot selected correctly", () => {
  const chunks = [...nChunks("big.ts", 5), ...nChunks("mid.ts", 3), ...nChunks("x.ts", 2)];
  const h = buildRetrievalHotspots(chunks);
  assert.equal(h.dominantHotspot?.filePath, "big.ts");
  assert.equal(h.dominantHotspot?.severity, "high");
});

test("7. concentrationLevel balanced (top < 30%)", () => {
  const chunks = Array.from({ length: 10 }, (_, i) => chunk(`f${i}.ts`)); // 10% top
  assert.equal(buildRetrievalHotspots(chunks).concentrationLevel, "balanced");
});

test("8. concentrationLevel moderate (top 30-49%)", () => {
  const chunks = [...nChunks("a.ts", 3), ...Array.from({ length: 7 }, (_, i) => chunk(`f${i}.ts`))];
  assert.equal(buildRetrievalHotspots(chunks).concentrationLevel, "moderate");
});

test("9. concentrationLevel concentrated (top >= 50%)", () => {
  const chunks = [...nChunks("a.ts", 6), ...Array.from({ length: 4 }, (_, i) => chunk(`f${i}.ts`))];
  assert.equal(buildRetrievalHotspots(chunks).concentrationLevel, "concentrated");
});

test("10. hotspotFiles sorting (percentage desc, chunkCount desc, filePath asc)", () => {
  // a:3 (30%), b:3 (30%), c:2 (20%) out of 10 -> a,b tie on % -> filePath asc
  const chunks = [
    ...nChunks("b.ts", 3),
    ...nChunks("a.ts", 3),
    ...nChunks("c.ts", 2),
    ...nChunks("d.ts", 2), // 20% filler to reach 10 total
  ];
  const h = buildRetrievalHotspots(chunks);
  assert.deepEqual(
    h.hotspotFiles.map((f) => f.filePath),
    ["a.ts", "b.ts", "c.ts", "d.ts"],
  );
});

test("11. percentage rounding to 3 decimals", () => {
  // a.ts = 1/3 = 33.333%
  const chunks = [...nChunks("a.ts", 1), ...nChunks("b.ts", 1), ...nChunks("c.ts", 1)];
  // none >= 20%? 33.3% >= 20 -> all three are hotspots at 33.333
  const a = buildRetrievalHotspots(chunks).hotspotFiles[0];
  assert.equal(a?.percentage, 33.333);
});

test("12. deterministic repeated execution", () => {
  const input = [...nChunks("a.ts", 3), ...nChunks("b.ts", 2)];
  assert.deepEqual(buildRetrievalHotspots(input), buildRetrievalHotspots(input));
});

test("13. input chunk array is not mutated", () => {
  const input = [...nChunks("a.ts", 2), ...nChunks("b.ts", 1)];
  const snapshot = input.map((c) => ({ ...c, signals: { ...c.signals } }));
  buildRetrievalHotspots(input);
  assert.deepEqual(input, snapshot);
});

test("14. exposure seam preserves retrievalHotspots exactly", () => {
  const retrievalHotspots = buildRetrievalHotspots([...nChunks("a.ts", 5), ...nChunks("b.ts", 5)]);
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 1,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 10,
    sourceCounts: { semantic: 10, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
    retrievalHotspots,
  };
  const meta = buildRetrievalMetadata(stats);
  assert.deepEqual(meta.retrievalHotspots, retrievalHotspots);
});

test("15. exposure omits retrievalHotspots when absent (backward compatible)", () => {
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 0,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 0,
    sourceCounts: { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
  };
  const meta = buildRetrievalMetadata(stats);
  assert.ok(!("retrievalHotspots" in meta));
});
test("16. hotspot calculation handles same file chunks with different line ranges", () => {
  const chunks: EnrichedContextChunk[] = [
    chunk("src/session.ts"),
    chunk("src/session.ts"),
    chunk("src/session.ts"),
    chunk("src/auth.ts"),
    chunk("src/auth.ts"),
  ];

  const h = buildRetrievalHotspots(chunks);

  assert.equal(h.hotspotCount, 2);
  assert.equal(h.dominantHotspot?.filePath, "src/session.ts");
  assert.equal(h.dominantHotspot?.chunkCount, 3);
  assert.equal(h.dominantHotspot?.percentage, 60);

  const auth = h.hotspotFiles.find((f) => f.filePath === "src/auth.ts");
  assert.equal(auth?.chunkCount, 2);
  assert.equal(auth?.percentage, 40);
});