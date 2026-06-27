import type { RepositoryIntelligenceResult } from "./repositoryIntelligenceService.js";

export interface RepositoryIntelligenceResponse {
  success: true;
  data: RepositoryIntelligenceResult;
}

export function buildRepositoryIntelligenceResponse(
  intelligence: RepositoryIntelligenceResult,
): RepositoryIntelligenceResponse {
  return {
    success: true,
    data: intelligence,
  };
}