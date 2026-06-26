import type { RepositoryIntelligenceResult } from "./repositoryIntelligenceService.js";

export function buildRepositoryIntelligenceRecommendations(
  intelligence: RepositoryIntelligenceResult,
): string[] {
  const recommendations: string[] = [];

  if (!intelligence.status.indexed) {
    recommendations.push("Index the repository to enable full intelligence.");
  }

  if (!intelligence.status.architectureReady) {
    recommendations.push("Generate an architecture report.");
  }

  if (!intelligence.status.retrievalReady) {
    recommendations.push("Improve retrieval quality.");
  }

  if (intelligence.intelligence.score < 70) {
    recommendations.push(
      "Improve overall repository health and intelligence score.",
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "Repository intelligence is in a healthy state.",
    );
  }

  return recommendations;
}