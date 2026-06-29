import type { RepositoryIndexingMetrics } from "./indexingMetrics.js";

export interface RepositoryIndexingHealth {
  healthy: boolean;
  level: "healthy" | "warning" | "critical";
  issues: string[];
}

export function buildRepositoryIndexingHealth(
  metrics: RepositoryIndexingMetrics,
): RepositoryIndexingHealth {
  const issues: string[] = [];

  if (metrics.totalFiles === 0) {
    issues.push("No files indexed.");
  }

  if (metrics.totalChunks === 0) {
    issues.push("No chunks indexed.");
  }

  if (metrics.totalSymbols === 0) {
    issues.push("No symbols indexed.");
  }

  if (metrics.graphDensity > 10) {
    issues.push("Graph dependency density is very high.");
  }

  const level =
    issues.length === 0
      ? "healthy"
      : issues.length <= 2
        ? "warning"
        : "critical";

  return {
    healthy: issues.length === 0,
    level,
    issues,
  };
}