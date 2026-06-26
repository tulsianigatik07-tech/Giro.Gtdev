import type {
  RepositoryIntelligenceResult,
} from "./repositoryIntelligenceService.js";

export interface RepositoryIntelligenceDashboard {
  repositoryId: string;
  repositoryName: string;
  intelligenceScore: number;
  intelligenceGrade: string;
  healthScore: number;
  indexed: boolean;
  architectureReady: boolean;
  retrievalReady: boolean;
}

export function buildRepositoryIntelligenceDashboard(
  intelligence: RepositoryIntelligenceResult,
): RepositoryIntelligenceDashboard {
  return {
    repositoryId: intelligence.repositoryId,
    repositoryName: intelligence.repositoryName,
    intelligenceScore:
      intelligence.intelligence.score,
    intelligenceGrade:
      intelligence.intelligence.grade,
    healthScore:
      intelligence.summary.healthScore,
    indexed:
      intelligence.status.indexed,
    architectureReady:
      intelligence.status.architectureReady,
    retrievalReady:
      intelligence.status.retrievalReady,
  };
}