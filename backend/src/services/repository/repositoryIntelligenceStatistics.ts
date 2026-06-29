import {
  getRepositoryIntelligenceHistory,
} from "./repositoryIntelligenceHistory.js";

export interface RepositoryIntelligenceStatistics {
  snapshots: number;
  averageHealthScore: number;
  averageIntelligenceScore: number;
}

export function buildRepositoryIntelligenceStatistics(
  repositoryId: string,
): RepositoryIntelligenceStatistics {
  const history = getRepositoryIntelligenceHistory(repositoryId);

  if (history.length === 0) {
    return {
      snapshots: 0,
      averageHealthScore: 0,
      averageIntelligenceScore: 0,
    };
  }

  const totalHealth = history.reduce(
    (sum, entry) => sum + entry.intelligence.summary.healthScore,
    0,
  );

  const totalIntelligence = history.reduce(
    (sum, entry) => sum + entry.intelligence.intelligence.score,
    0,
  );

  return {
    snapshots: history.length,
    averageHealthScore: totalHealth / history.length,
    averageIntelligenceScore:
      totalIntelligence / history.length,
  };
}