import type {
  RepositoryIntelligenceResult,
} from "./repositoryIntelligenceService.js";
import { buildRepositoryIntelligenceTimeline } from "./repositoryIntelligenceTimeline.js";
import { buildRepositoryIntelligenceHealthSummary } from "./repositoryIntelligenceHealthSummary.js";

export interface RepositoryIntelligenceDashboard {
  repositoryId: string;
  repositoryName: string;
  intelligenceScore: number;
  intelligenceGrade: string;
  healthScore: number;
  indexed: boolean;
  architectureReady: boolean;
  retrievalReady: boolean;
  timelineLength: number;
  healthSummary: ReturnType<typeof buildRepositoryIntelligenceHealthSummary>;
}

export function buildRepositoryIntelligenceDashboard(
  intelligence: RepositoryIntelligenceResult,
): RepositoryIntelligenceDashboard {
  const timeline = buildRepositoryIntelligenceTimeline(
    intelligence.repositoryId,
    
  );
  const healthSummary = buildRepositoryIntelligenceHealthSummary(intelligence);

  return {
    repositoryId: intelligence.repositoryId,
    repositoryName: intelligence.repositoryName,
    intelligenceScore: intelligence.intelligence.score,
    intelligenceGrade: intelligence.intelligence.grade,
    healthScore: intelligence.summary.healthScore,
    indexed: intelligence.status.indexed,
    architectureReady: intelligence.status.architectureReady,
    retrievalReady: intelligence.status.retrievalReady,
    timelineLength: timeline.length,
    healthSummary,
  };
}