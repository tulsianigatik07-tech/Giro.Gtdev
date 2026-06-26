import type {
  RepositoryIntelligenceScore,
} from "./repositoryIntelligenceScore.js";

export function buildRepositoryIntelligenceText(
  score: RepositoryIntelligenceScore,
): string {
  return [
    `Repository Intelligence`,
    `Score: ${score.score}/100`,
    `Grade: ${score.grade}`,
  ].join("\n");
}