import type { RepositoryOverview } from "./repositoryOverview.js";
import { analyzeRepository } from "./repositoryAnalysisService.js";
import { getArchitectureDashboardData } from "./architectureDashboardIntegration.js";

export interface RepositoryIntelligenceInput {
  repositoryId: string;
  repositoryName: string;
  overview: RepositoryOverview;
}

export interface RepositoryIntelligenceResult {
  repositoryId: string;
  repositoryName: string;
  analysis: ReturnType<typeof analyzeRepository>;
  architecture: ReturnType<typeof getArchitectureDashboardData>;
}

export function buildRepositoryIntelligence(
  input: RepositoryIntelligenceInput,
): RepositoryIntelligenceResult {
  return {
    repositoryId: input.repositoryId,
    repositoryName: input.repositoryName,
    analysis: analyzeRepository(input.repositoryName, input.overview),
    architecture: getArchitectureDashboardData(input.repositoryId),
  };
}