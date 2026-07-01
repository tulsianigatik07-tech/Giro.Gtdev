import {
  buildRepositoryReadinessScore,
  type RepositoryReadinessInput,
} from "./repositoryReadinessScore.js";

export interface RepositoryReadinessDashboard {
  score: number;
  level: string;
  indexed: boolean;
  architectureReady: boolean;
  retrievalReady: boolean;
}

export function buildRepositoryReadinessDashboard(
  input: RepositoryReadinessInput,
): RepositoryReadinessDashboard {
  const readiness = buildRepositoryReadinessScore(input);

  return {
    score: readiness.score,
    level: readiness.level,
    indexed: input.indexed,
    architectureReady: input.architectureReady,
    retrievalReady: input.retrievalReady,
  };
}