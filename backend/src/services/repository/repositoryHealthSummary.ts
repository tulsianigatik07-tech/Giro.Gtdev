// Pure, deterministic repository-health engine. Derives stable indicators
// entirely from a RepositoryOverview. NOT AI. No I/O, timestamps, randomness,
// or module state; never mutates the input. Identical input -> deepEqual output.
//
// All denominators use overview.structure.totalFiles (architecture also carries
// a totalFiles; structure's count is the source of truth here).

import type { RepositoryOverview } from "./repositoryOverview.js";

export interface RepositoryHealthSummary {
  scale: "small" | "medium" | "large";
  complexity: "low" | "medium" | "high";
  fileCoverage: number;
  dependencyDensity: number;
  healthScore: number;
  healthCategory: "excellent" | "good" | "fair" | "poor";
}

function categorize(score: number): RepositoryHealthSummary["healthCategory"] {
  if (score >= 90) return "excellent";
  if (score >= 70) return "good";
  if (score >= 50) return "fair";
  return "poor";
}

export function buildRepositoryHealthSummary(
  overview: RepositoryOverview,
): RepositoryHealthSummary {
  const { structure, architecture } = overview;
  const totalFiles = structure.totalFiles;

  const scale = structure.repositoryScale;
  const complexity = architecture.architectureComplexity;

  const fileCoverage =
    totalFiles === 0 ? 0 : Number((structure.totalSymbols / totalFiles).toFixed(2));
  const dependencyDensity =
    totalFiles === 0 ? 0 : Number((architecture.totalDependencies / totalFiles).toFixed(2));

  let score = 100;
  if (complexity === "high") score -= 25;
  else if (complexity === "medium") score -= 10;

  if (dependencyDensity > 10) score -= 25;
  else if (dependencyDensity > 5) score -= 10;

  if (fileCoverage < 1) score -= 25;
  else if (fileCoverage < 3) score -= 10;

  score = Math.max(0, Math.min(100, score));

  return {
    scale,
    complexity,
    fileCoverage,
    dependencyDensity,
    healthScore: score,
    healthCategory: categorize(score),
  };
}
