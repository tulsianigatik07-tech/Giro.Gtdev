export interface RepositoryReadinessInput {
  indexed: boolean;
  architectureReady: boolean;
  retrievalReady: boolean;
  healthScore: number;
}

export interface RepositoryReadinessResult {
  score: number;
  level: "poor" | "fair" | "good" | "excellent";
}

export function buildRepositoryReadinessScore(
  input: RepositoryReadinessInput,
): RepositoryReadinessResult {
  let score = input.healthScore;

  if (input.indexed) {
    score += 10;
  }

  if (input.architectureReady) {
    score += 10;
  }

  if (input.retrievalReady) {
    score += 10;
  }

  score = Math.min(score, 100);

  let level: RepositoryReadinessResult["level"];

  if (score >= 90) {
    level = "excellent";
  } else if (score >= 75) {
    level = "good";
  } else if (score >= 50) {
    level = "fair";
  } else {
    level = "poor";
  }

  return {
    score,
    level,
  };
}