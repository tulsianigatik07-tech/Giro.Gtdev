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
  // Last index execution mode + change volume (inlined union to avoid a
  // cross-file type dependency on indexingPlan.ts).
  lastIndexMode: "full" | "incremental" | null;
  lastChangedFileCount: number;
  // Retry-safe indexing foundation (additive; failure/retry tracking).
  lastFailureAt: string | null;
  failureReason: string | null;
  failedFileCount: number;
  lastSuccessfulFile: string | null;
  retryCount: number;
  lastRetryAt: string | null;
  lastLifecycleSeverity: "none" | "low" | "medium" | "high" | null;
lastReindexMode: "none" | "incremental" | "full" | null;
lastReindexReason: string | null;
}
