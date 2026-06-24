import type { RepositoryHealthSummary } from "./repositoryHealthSummary.js";

export function buildRepositoryHealthBadge(
  summary: RepositoryHealthSummary,
): string {
  if (summary.healthScore >= 90) {
    return "EXCELLENT";
  }

  if (summary.healthScore >= 75) {
    return "GOOD";
  }

  if (summary.healthScore >= 50) {
    return "FAIR";
  }

  return "POOR";
}