// Pure, deterministic engine combining a RepositoryOverview + RepositoryHealth
// Summary into a compact, retrieval-ready context object for future consumers.
// NOT AI, NOT semantic retrieval. No I/O, timestamps, randomness, or module
// state; never mutates inputs. Identical input -> deepEqual output.
//
// totalFiles comes from overview.structure.totalFiles (architecture also has a
// totalFiles; structure's count is the source of truth here).

import type { RepositoryOverview } from "./repositoryOverview.js";
import type { RepositoryHealthSummary } from "./repositoryHealthSummary.js";

export interface RetrievalContextSummary {
  repositoryScale: "small" | "medium" | "large";
  architectureComplexity: "low" | "medium" | "high";
  healthCategory: "excellent" | "good" | "fair" | "poor";
  totalFiles: number;
  totalSymbols: number;
  totalDependencies: number;
  retrievalKeywords: string[];
}

export function buildRetrievalContextSummary(
  overview: RepositoryOverview,
  health: RepositoryHealthSummary,
): RetrievalContextSummary {
  const repositoryScale = overview.structure.repositoryScale;
  const architectureComplexity = overview.architecture.architectureComplexity;
  const healthCategory = health.healthCategory;
  const totalFiles = overview.structure.totalFiles;
  const totalSymbols = overview.structure.totalSymbols;
  const totalDependencies = overview.architecture.totalDependencies;

  return {
    repositoryScale,
    architectureComplexity,
    healthCategory,
    totalFiles,
    totalSymbols,
    totalDependencies,
    retrievalKeywords: [
      `scale:${repositoryScale}`,
      `complexity:${architectureComplexity}`,
      `health:${healthCategory}`,
      `files:${totalFiles}`,
      `symbols:${totalSymbols}`,
      `dependencies:${totalDependencies}`,
    ],
  };
}
