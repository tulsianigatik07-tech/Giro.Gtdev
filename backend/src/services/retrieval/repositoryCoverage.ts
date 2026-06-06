// Deterministic repository coverage metadata: how retrieval coverage is
// distributed across repository files. Metadata ONLY — never affects retrieval,
// reranking, confidence, explainability, budgeting, or answer generation.
// No AI, no randomness, no timestamps. Inputs are never mutated. Never exposes
// raw chunk content.

import type { EnrichedContextChunk } from "../context/contextTypes.js";

export interface RepositoryCoverageFile {
  filePath: string;
  chunkCount: number;
  percentage: number;
}

export interface RepositoryCoverage {
  totalFilesRetrieved: number;
  totalChunksRetrieved: number;
  averageChunksPerFile: number;
  dominantFile?: string;
  dominantFileChunkCount: number;
  fileDistribution: RepositoryCoverageFile[];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function buildRepositoryCoverage(
  chunks: EnrichedContextChunk[],
): RepositoryCoverage {
  const totalChunksRetrieved = chunks.length;

  if (totalChunksRetrieved === 0) {
    return {
      totalFilesRetrieved: 0,
      totalChunksRetrieved: 0,
      averageChunksPerFile: 0,
      dominantFile: undefined,
      dominantFileChunkCount: 0,
      fileDistribution: [],
    };
  }

  const countByFile = new Map<string, number>();
  for (const chunk of chunks) {
    countByFile.set(chunk.filePath, (countByFile.get(chunk.filePath) ?? 0) + 1);
  }

  const fileDistribution: RepositoryCoverageFile[] = [...countByFile.entries()]
    .map(([filePath, chunkCount]) => ({
      filePath,
      chunkCount,
      percentage: round3((chunkCount / totalChunksRetrieved) * 100),
    }))
    .sort(
      (a, b) => b.chunkCount - a.chunkCount || a.filePath.localeCompare(b.filePath),
    );

  const totalFilesRetrieved = fileDistribution.length;

  // fileDistribution is already sorted by chunkCount desc then filePath asc, so
  // the first entry is the dominant file with the alphabetical tiebreak applied.
  const dominant = fileDistribution[0];

  return {
    totalFilesRetrieved,
    totalChunksRetrieved,
    averageChunksPerFile: round3(totalChunksRetrieved / totalFilesRetrieved),
    dominantFile: dominant?.filePath,
    dominantFileChunkCount: dominant?.chunkCount ?? 0,
    fileDistribution,
  };
}
