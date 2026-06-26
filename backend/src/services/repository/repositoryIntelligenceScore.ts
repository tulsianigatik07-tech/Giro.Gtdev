export interface RepositoryIntelligenceScoreInput {
  healthScore: number;
  indexed: boolean;
  architectureReady: boolean;
  retrievalScore: number;
}

export interface RepositoryIntelligenceScore {
  score: number;
  grade: "excellent" | "good" | "fair" | "poor";
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.round(score)));
}

function gradeFor(score: number): RepositoryIntelligenceScore["grade"] {
  if (score >= 85) return "excellent";
  if (score >= 70) return "good";
  if (score >= 50) return "fair";
  return "poor";
}

export function buildRepositoryIntelligenceScore(
  input: RepositoryIntelligenceScoreInput,
): RepositoryIntelligenceScore {
  const score = clampScore(
    input.healthScore * 0.5 +
      (input.indexed ? 20 : 0) +
      (input.architectureReady ? 15 : 0) +
      input.retrievalScore * 15,
  );

  return {
    score,
    grade: gradeFor(score),
  };
}