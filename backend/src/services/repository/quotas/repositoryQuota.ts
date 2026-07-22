import { env } from "../../../config/env.js";

export type RepositoryQuotaReason =
  | "repository_size"
  | "file_count"
  | "directory_depth"
  | "file_size"
  | "symlink_count"
  | "binary_file_count"
  | "indexed_text_bytes"
  | "artifact_size"
  | "indexing_duration"
  | "concurrent_indexing"
  | "indexed_repositories"
  | "user_storage";

export interface RepositoryQuotas {
  maxRepositoryBytes: number;
  maxFiles: number;
  maxDirectoryDepth: number;
  maxFileBytes: number;
  maxSymlinks: number;
  maxBinaryFiles: number;
  maxIndexedTextBytes: number;
  maxArtifactBytes: number;
  maxIndexingDurationMs: number;
  maxConcurrentIndexingPerUser: number;
  maxIndexedRepositoriesPerUser: number;
  maxStorageBytesPerUser: number;
}

export const runtimeRepositoryQuotas: RepositoryQuotas = Object.freeze({
  maxRepositoryBytes: env.REPOSITORY_QUOTA_MAX_BYTES,
  maxFiles: env.REPOSITORY_QUOTA_MAX_FILES,
  maxDirectoryDepth: env.REPOSITORY_QUOTA_MAX_DIRECTORY_DEPTH,
  maxFileBytes: env.REPOSITORY_QUOTA_MAX_FILE_BYTES,
  maxSymlinks: env.REPOSITORY_QUOTA_MAX_SYMLINKS,
  maxBinaryFiles: env.REPOSITORY_QUOTA_MAX_BINARY_FILES,
  maxIndexedTextBytes: env.REPOSITORY_QUOTA_MAX_INDEXED_TEXT_BYTES,
  maxArtifactBytes: env.REPOSITORY_QUOTA_MAX_ARTIFACT_BYTES,
  maxIndexingDurationMs: env.REPOSITORY_QUOTA_MAX_INDEXING_DURATION_MS,
  maxConcurrentIndexingPerUser: env.REPOSITORY_QUOTA_MAX_CONCURRENT_PER_USER,
  maxIndexedRepositoriesPerUser: env.REPOSITORY_QUOTA_MAX_REPOSITORIES_PER_USER,
  maxStorageBytesPerUser: env.REPOSITORY_QUOTA_MAX_STORAGE_PER_USER_BYTES,
});

export class RepositoryQuotaError extends Error {
  readonly code = "repository_quota_exceeded";

  constructor(
    readonly reason: RepositoryQuotaReason,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`Repository quota exceeded: ${reason}.`);
    this.name = "RepositoryQuotaError";
  }
}

export function assertRepositoryQuota(
  reason: RepositoryQuotaReason,
  observed: number,
  limit: number,
): void {
  if (observed > limit) throw new RepositoryQuotaError(reason, limit, observed);
}

export function serializedArtifactBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function isRepositoryQuotaError(error: unknown): error is RepositoryQuotaError {
  if (error instanceof RepositoryQuotaError) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; reason?: unknown; limit?: unknown; observed?: unknown };
  return value.code === "repository_quota_exceeded" && typeof value.reason === "string" &&
    typeof value.limit === "number" && typeof value.observed === "number";
}

export function repositoryQuotaErrorFromMessage(message: string | undefined): RepositoryQuotaError | null {
  const match = message?.match(/repository_quota_exceeded:([a-z_]+)/);
  if (!match) return null;
  const reason = match[1] as RepositoryQuotaReason;
  const limits: Record<RepositoryQuotaReason, number> = {
    repository_size: runtimeRepositoryQuotas.maxRepositoryBytes,
    file_count: runtimeRepositoryQuotas.maxFiles,
    directory_depth: runtimeRepositoryQuotas.maxDirectoryDepth,
    file_size: runtimeRepositoryQuotas.maxFileBytes,
    symlink_count: runtimeRepositoryQuotas.maxSymlinks,
    binary_file_count: runtimeRepositoryQuotas.maxBinaryFiles,
    indexed_text_bytes: runtimeRepositoryQuotas.maxIndexedTextBytes,
    artifact_size: runtimeRepositoryQuotas.maxArtifactBytes,
    indexing_duration: runtimeRepositoryQuotas.maxIndexingDurationMs,
    concurrent_indexing: runtimeRepositoryQuotas.maxConcurrentIndexingPerUser,
    indexed_repositories: runtimeRepositoryQuotas.maxIndexedRepositoriesPerUser,
    user_storage: runtimeRepositoryQuotas.maxStorageBytesPerUser,
  };
  const limit = limits[reason];
  return limit === undefined ? null : new RepositoryQuotaError(reason, limit, limit + 1);
}
