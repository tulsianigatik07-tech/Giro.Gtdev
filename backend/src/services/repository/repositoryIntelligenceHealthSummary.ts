import type { RepositoryIntelligenceResult } from "./repositoryIntelligenceService.js";

export interface RepositoryIntelligenceHealthSummary {
  repositoryId: string;
  intelligenceScore: number;
  readinessScore: number;
  healthScore: number;
  indexed: boolean;
  ready: boolean;
}

export function buildRepositoryIntelligenceHealthSummary(
  intelligence: RepositoryIntelligenceResult,
): RepositoryIntelligenceHealthSummary {
  return {
    repositoryId: intelligence.repositoryId,
    intelligenceScore: intelligence.intelligence.score,
    readinessScore: intelligence.readiness.score,
    healthScore: intelligence.summary.healthScore,
    indexed: intelligence.status.indexed,
    ready: intelligence.status.ready,
  };
}