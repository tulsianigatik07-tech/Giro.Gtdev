// Deterministic retrieval quality score: a single summary grade built ONLY from
// existing deterministic metadata layers (confidence, diversity, coverage,
// hotspots, blind spots). Metadata ONLY — never affects retrieval, reranking,
// or answers. Does NOT inspect chunks or recompute upstream metadata. No AI,
// no randomness, no timestamps. Inputs are never mutated.

export interface RetrievalQualityScore {
  score: number;
  grade: "excellent" | "good" | "fair" | "poor";
  factors: {
    confidence: number;
    diversity: number;
    coverage: number;
    hotspotPenalty: number;
    blindSpotPenalty: number;
  };
}

export interface RetrievalQualityInput {
  confidence?: number;
  retrievalDiversity?: {
    diversityScore: number;
    concentrationScore: number;
    classification: string;
  };
  repositoryCoverage?: {
    totalFilesRetrieved: number;
    totalChunksRetrieved: number;
  };
  retrievalHotspots?: {
    hotspotCount: number;
    concentrationLevel: string;
  };
  retrievalBlindSpots?: {
    blindSpotCount: number;
    hasBlindSpots: boolean;
  };
}

const W_CONFIDENCE = 0.4;
const W_DIVERSITY = 0.25;
const W_COVERAGE = 0.2;
const COVERAGE_TARGET_FILES = 5;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function gradeFor(score: number): RetrievalQualityScore["grade"] {
  if (score >= 0.85) return "excellent";
  if (score >= 0.7) return "good";
  if (score >= 0.5) return "fair";
  return "poor";
}

function coverageFactor(
  coverage: RetrievalQualityInput["repositoryCoverage"],
): number {
  if (!coverage || coverage.totalChunksRetrieved === 0) return 0;
  return round3(Math.min(1, coverage.totalFilesRetrieved / COVERAGE_TARGET_FILES));
}

function hotspotPenaltyFor(
  hotspots: RetrievalQualityInput["retrievalHotspots"],
): number {
  if (!hotspots) return 0;
  if (hotspots.concentrationLevel === "concentrated") return 0.3;
  if (hotspots.concentrationLevel === "moderate") return 0.15;
  return 0; // "balanced" or any other value
}

function blindSpotPenaltyFor(
  blindSpots: RetrievalQualityInput["retrievalBlindSpots"],
): number {
  if (!blindSpots || !blindSpots.hasBlindSpots) return 0;
  return Math.min(0.3, blindSpots.blindSpotCount * 0.05);
}

export function buildRetrievalQualityScore(
  input: RetrievalQualityInput,
): RetrievalQualityScore {
  const confidence = clamp01(input.confidence ?? 0);
  const diversity = clamp01(input.retrievalDiversity?.diversityScore ?? 0);
  const coverage = coverageFactor(input.repositoryCoverage);
  const hotspotPenalty = hotspotPenaltyFor(input.retrievalHotspots);
  const blindSpotPenalty = blindSpotPenaltyFor(input.retrievalBlindSpots);

  const raw =
    confidence * W_CONFIDENCE +
    diversity * W_DIVERSITY +
    coverage * W_COVERAGE -
    hotspotPenalty -
    blindSpotPenalty;

  const score = round3(clamp01(raw));

  return {
    score,
    grade: gradeFor(score),
    factors: {
      confidence: round3(confidence),
      diversity: round3(diversity),
      coverage: round3(coverage),
      hotspotPenalty: round3(hotspotPenalty),
      blindSpotPenalty: round3(blindSpotPenalty),
    },
  };
}
