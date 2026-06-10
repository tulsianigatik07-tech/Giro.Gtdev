import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRetrievalQualityScore,
  type RetrievalQualityInput,
} from "../services/retrieval/retrievalQualityScore.js";
import { buildRetrievalMetadata } from "../services/retrieval/retrievalMetadataExposure.js";
import type { EnrichedAssembledContext } from "../services/context/contextTypes.js";

function diversity(diversityScore: number): RetrievalQualityInput["retrievalDiversity"] {
  return { diversityScore, concentrationScore: 1 - diversityScore, classification: "x" };
}
function coverage(files: number, chunks: number): RetrievalQualityInput["repositoryCoverage"] {
  return { totalFilesRetrieved: files, totalChunksRetrieved: chunks };
}
function hotspots(level: string): RetrievalQualityInput["retrievalHotspots"] {
  return { hotspotCount: 0, concentrationLevel: level };
}
function blindSpots(count: number): RetrievalQualityInput["retrievalBlindSpots"] {
  return { blindSpotCount: count, hasBlindSpots: count > 0 };
}

test("1. empty input returns poor zeroed score", () => {
  assert.deepEqual(buildRetrievalQualityScore({}), {
    score: 0,
    grade: "poor",
    factors: { confidence: 0, diversity: 0, coverage: 0, hotspotPenalty: 0, blindSpotPenalty: 0 },
  });
});

test("2. confidence factor preserved and clamped (>1 -> 1)", () => {
  const r = buildRetrievalQualityScore({ confidence: 5 });
  assert.equal(r.factors.confidence, 1);
  assert.equal(r.score, 0.4); // 1*0.4
});

test("3. diversity factor preserved and clamped", () => {
  const r = buildRetrievalQualityScore({ retrievalDiversity: diversity(2) });
  assert.equal(r.factors.diversity, 1);
});

test("4. coverage factor calc (/5 cap, and 0 when no chunks)", () => {
  assert.equal(buildRetrievalQualityScore({ repositoryCoverage: coverage(2, 10) }).factors.coverage, 0.4);
  assert.equal(buildRetrievalQualityScore({ repositoryCoverage: coverage(10, 10) }).factors.coverage, 1);
  assert.equal(buildRetrievalQualityScore({ repositoryCoverage: coverage(3, 0) }).factors.coverage, 0);
});

test("5. balanced hotspot penalty is 0", () => {
  assert.equal(buildRetrievalQualityScore({ retrievalHotspots: hotspots("balanced") }).factors.hotspotPenalty, 0);
});

test("6. moderate hotspot penalty is 0.15", () => {
  assert.equal(buildRetrievalQualityScore({ retrievalHotspots: hotspots("moderate") }).factors.hotspotPenalty, 0.15);
});

test("7. concentrated hotspot penalty is 0.30", () => {
  assert.equal(buildRetrievalQualityScore({ retrievalHotspots: hotspots("concentrated") }).factors.hotspotPenalty, 0.3);
});

test("8. blind spot penalty = count * 0.05", () => {
  assert.equal(buildRetrievalQualityScore({ retrievalBlindSpots: blindSpots(3) }).factors.blindSpotPenalty, 0.15);
});

test("9. blind spot penalty cap at 0.30", () => {
  assert.equal(buildRetrievalQualityScore({ retrievalBlindSpots: blindSpots(20) }).factors.blindSpotPenalty, 0.3);
});

test("10. final score weighted calculation matches formula", () => {
  // 0.8*0.4 + 0.6*0.25 + 1.0*0.2 - 0.15 - 0.05 = 0.32+0.15+0.20-0.20 = 0.47
  const r = buildRetrievalQualityScore({
    confidence: 0.8,
    retrievalDiversity: diversity(0.6),
    repositoryCoverage: coverage(5, 10),
    retrievalHotspots: hotspots("moderate"),
    retrievalBlindSpots: blindSpots(1),
  });
  assert.equal(r.score, 0.47);
  assert.equal(r.grade, "poor");
});

test("11. score clamped to [0,1] (penalties cannot push below 0)", () => {
  const r = buildRetrievalQualityScore({
    confidence: 0,
    retrievalHotspots: hotspots("concentrated"),
    retrievalBlindSpots: blindSpots(20),
  });
  assert.equal(r.score, 0);
});

test("12. excellent grade (perfect inputs reach exactly 0.85)", () => {
  const r = buildRetrievalQualityScore({
    confidence: 1,
    retrievalDiversity: diversity(1),
    repositoryCoverage: coverage(5, 5),
    retrievalHotspots: hotspots("balanced"),
    retrievalBlindSpots: blindSpots(0),
  });
  assert.equal(r.score, 0.85);
  assert.equal(r.grade, "excellent");
});

test("13. good grade threshold (>= 0.70)", () => {
  // 1*0.4 + 1*0.25 + 0.5*0.2 = 0.75
  const r = buildRetrievalQualityScore({
    confidence: 1,
    retrievalDiversity: diversity(1),
    repositoryCoverage: coverage(2.5 * 1, 10), // files=2.5 -> 0.5; use 2.5? must be int-ish
  });
  // coverage(2.5,10) -> 2.5/5 = 0.5
  assert.equal(r.factors.coverage, 0.5);
  assert.equal(r.score, 0.75);
  assert.equal(r.grade, "good");
});

test("14. fair grade threshold (>= 0.50)", () => {
  // 1*0.4 + 0.4*0.25 = 0.5
  const r = buildRetrievalQualityScore({
    confidence: 1,
    retrievalDiversity: diversity(0.4),
  });
  assert.equal(r.score, 0.5);
  assert.equal(r.grade, "fair");
});

test("15. poor grade threshold (< 0.50)", () => {
  const r = buildRetrievalQualityScore({ confidence: 0.5 });
  assert.equal(r.score, 0.2);
  assert.equal(r.grade, "poor");
});

test("16. deterministic repeated execution", () => {
  const input: RetrievalQualityInput = {
    confidence: 0.7,
    retrievalDiversity: diversity(0.5),
    repositoryCoverage: coverage(3, 8),
    retrievalHotspots: hotspots("moderate"),
    retrievalBlindSpots: blindSpots(2),
  };
  assert.deepEqual(buildRetrievalQualityScore(input), buildRetrievalQualityScore(input));
});

test("17. input object is not mutated", () => {
  const input: RetrievalQualityInput = {
    confidence: 0.7,
    retrievalDiversity: diversity(0.5),
    repositoryCoverage: coverage(3, 8),
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  buildRetrievalQualityScore(input);
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
});

test("18. exposure seam preserves retrievalQualityScore exactly", () => {
  const retrievalQualityScore = buildRetrievalQualityScore({ confidence: 1, retrievalDiversity: diversity(1) });
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 1,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 1,
    sourceCounts: { semantic: 1, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
    retrievalQualityScore,
  };
  const meta = buildRetrievalMetadata(stats);
  assert.deepEqual(meta.retrievalQualityScore, retrievalQualityScore);
});

test("19. exposure omits retrievalQualityScore when absent (backward compatible)", () => {
  const stats: EnrichedAssembledContext["stats"] = {
    hybridResults: 0,
    fileSearchResults: 0,
    deduplicatedCount: 0,
    finalCount: 0,
    sourceCounts: { semantic: 0, keyword: 0, symbol: 0, graph: 0, fileSearch: 0 },
  };
  const meta = buildRetrievalMetadata(stats);
  assert.ok(!("retrievalQualityScore" in meta));
});

test("quality score is deterministic for identical inputs", () => {
  const input: RetrievalQualityInput = {
    confidence: 0.82,
    retrievalDiversity: diversity(0.7),
    repositoryCoverage: coverage(6, 14),
    retrievalHotspots: hotspots("moderate"),
    retrievalBlindSpots: blindSpots(1),
  };

  const first = buildRetrievalQualityScore(input);
  const second = buildRetrievalQualityScore(input);

  assert.deepEqual(first, second);
});