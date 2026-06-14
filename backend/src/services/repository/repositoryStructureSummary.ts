// Deterministic repository structure summary. NOT AI-generated — a pure
// projection of index metadata counts into a stable overview shape, plus a
// fileCount-based scale classification. Pure: no I/O, no timestamps, no
// randomness, no env access, no module state; never mutates the input.

import type { RepositoryIndexMetadata } from "./indexingTypes.js";

export interface RepositoryStructureSummary {
  totalFiles: number;
  totalChunks: number;
  totalSymbols: number;
  totalGraphNodes: number;
  totalGraphEdges: number;
  summaryAvailable: boolean;
  repositoryScale: "small" | "medium" | "large";
}

// Scale is based ONLY on fileCount: <50 small, [50,250) medium, >=250 large.
function classifyScale(fileCount: number): RepositoryStructureSummary["repositoryScale"] {
  if (fileCount >= 250) return "large";
  if (fileCount >= 50) return "medium";
  return "small";
}

export function buildRepositoryStructureSummary(
  metadata: RepositoryIndexMetadata,
): RepositoryStructureSummary {
  return {
    totalFiles: metadata.fileCount,
    totalChunks: metadata.chunkCount,
    totalSymbols: metadata.symbolCount,
    totalGraphNodes: metadata.graphNodeCount,
    totalGraphEdges: metadata.graphEdgeCount,
    summaryAvailable: metadata.summaryAvailable,
    repositoryScale: classifyScale(metadata.fileCount),
  };
}
