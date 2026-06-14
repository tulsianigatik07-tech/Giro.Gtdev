// Pure, deterministic text formatter rendering a RepositoryHealthSummary into a
// stable 7-line string for future UI cards / retrieval context / answer
// preambles. NOT AI — formatting only. No I/O, timestamps, randomness, or
// module state; never mutates the input. Identical input -> identical string.
//
// fileCoverage/dependencyDensity are pre-rounded Number(...toFixed(2)) values,
// rendered as-is via interpolation (2 -> "2", 2.5 -> "2.5", 0.33 -> "0.33").

import type { RepositoryHealthSummary } from "./repositoryHealthSummary.js";

export function buildRepositoryHealthText(health: RepositoryHealthSummary): string {
  return [
    "Repository health:",
    `- Scale: ${health.scale}`,
    `- Complexity: ${health.complexity}`,
    `- File coverage: ${health.fileCoverage}`,
    `- Dependency density: ${health.dependencyDensity}`,
    `- Health score: ${health.healthScore}`,
    `- Health category: ${health.healthCategory}`,
  ].join("\n");
}
