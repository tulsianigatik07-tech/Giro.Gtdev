import { getRepositoryIndexMetadata } from "./indexingService.js";

export interface RepositoryReadinessSnapshot {
  repository: string;
  ready: boolean;
  status: string;
  indexedFiles: number;
  indexedChunks: number;
  lastIndexedAt: string | null;
}

export function buildRepositoryReadinessSnapshot(
  owner: string,
  repo: string,
): RepositoryReadinessSnapshot {
  const metadata = getRepositoryIndexMetadata(owner, repo);

  if (!metadata) {
    return {
      repository: `${owner}/${repo}`,
      ready: false,
      status: "missing",
      indexedFiles: 0,
      indexedChunks: 0,
      lastIndexedAt: null,
    };
  }

  return {
    repository: `${owner}/${repo}`,
    ready: metadata.status === "indexed",
    status: metadata.status,
    indexedFiles: metadata.fileCount,
    indexedChunks: metadata.chunkCount,
    lastIndexedAt: metadata.lastIndexedAt,
  };
}