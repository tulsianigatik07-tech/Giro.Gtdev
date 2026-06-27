import type { RepositoryIndexMetadata } from "./indexingTypes.js";

export interface RepositoryIndexSummary {
  repository: string;
  status: string;
  indexed: boolean;
  totalFiles: number;
  totalChunks: number;
  totalSymbols: number;
  totalGraphNodes: number;
  totalGraphEdges: number;
  lastIndexedAt: string | null;
}

export function buildRepositoryIndexSummary(
  metadata: RepositoryIndexMetadata | null,
): RepositoryIndexSummary {
  if (!metadata) {
    return {
      repository: "",
      status: "unknown",
      indexed: false,
      totalFiles: 0,
      totalChunks: 0,
      totalSymbols: 0,
      totalGraphNodes: 0,
      totalGraphEdges: 0,
      lastIndexedAt: null,
    };
  }

  return {
    repository: `${metadata.owner}/${metadata.repo}`,
    status: metadata.status,
    indexed: metadata.status === "indexed",
    totalFiles: metadata.fileCount,
    totalChunks: metadata.chunkCount,
    totalSymbols: metadata.symbolCount,
    totalGraphNodes: metadata.graphNodeCount,
    totalGraphEdges: metadata.graphEdgeCount,
    lastIndexedAt: metadata.lastIndexedAt,
  };
}