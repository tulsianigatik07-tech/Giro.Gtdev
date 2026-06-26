import { getRepositoryIntelligenceHistory } from "./repositoryIntelligenceHistory.js";

export interface RepositoryIntelligenceTrendPoint {
  generatedAt: string;
  score: number;
  grade: string;
}

export function getRepositoryIntelligenceTrend(
  repositoryId: string,
): RepositoryIntelligenceTrendPoint[] {
  return getRepositoryIntelligenceHistory(repositoryId).map((entry) => ({
    generatedAt: entry.generatedAt,
    score: entry.intelligence.intelligence.score,
    grade: entry.intelligence.intelligence.grade,
  }));
}