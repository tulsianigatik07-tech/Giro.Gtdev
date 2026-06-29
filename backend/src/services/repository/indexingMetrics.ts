import type { RepositoryIndexMetadata } from "./indexingTypes.js";

export interface RepositoryIndexingMetrics {
  totalFiles: number;
  totalChunks: number;
  totalSymbols: number;
  graphDensity: number;
}

export function buildRepositoryIndexingMetrics(
  metadata: RepositoryIndexMetadata | null,
): RepositoryIndexingMetrics {
  if (!metadata) {
    return {
      totalFiles: 0,
      totalChunks: 0,
      totalSymbols: 0,
      graphDensity: 0,
    };
  }

  const graphDensity =
    metadata.graphNodeCount === 0
      ? 0
      : metadata.graphEdgeCount / metadata.graphNodeCount;

  return {
    totalFiles: metadata.fileCount,
    totalChunks: metadata.chunkCount,
    totalSymbols: metadata.symbolCount,
    graphDensity,
  };
}