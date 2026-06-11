// Repository indexing lifecycle types.

export type RepositoryIndexStatus = "indexing" | "indexed" | "failed" | "stale";

export interface RepositoryIndexMetadata {
  owner: string;
  repo: string;
  status: RepositoryIndexStatus;
  indexedAt: string | null;
  lastAccessedAt: string | null;
  chunkCount: number;
  fileCount: number;
  symbolCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  summaryAvailable: boolean;
  // Incremental indexing lifecycle metadata (additive, historical).
  firstIndexedAt: string | null;
  lastIndexedAt: string | null;
  totalIndexedFiles: number;
}
