import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../../lib/supabase.js";
import type { IndexedCounts, SetRepositoryIndexedOptions } from "../../repository/indexingService.js";
import type { RepositorySummary } from "../../repositorySummary/summaryTypes.js";
import { IndexingJobLeaseConflictError } from "../jobs/indexingJobStore.js";
import { repositoryQuotaErrorFromMessage, runtimeRepositoryQuotas } from "../../repository/quotas/repositoryQuota.js";

export interface RepositorySnapshotIdentity {
  repositoryId: string;
  revision: string;
  branch: string | null;
  jobId: string;
  workerId: string;
  claimToken: string;
}

export interface BeginRepositorySnapshotResult {
  alreadyPublished: boolean;
  counts: IndexedCounts | null;
}

export interface PublishRepositorySnapshotInput extends RepositorySnapshotIdentity {
  counts: IndexedCounts;
  embeddingVersion: string;
  intelligenceVersion?: string;
  indexOptions?: SetRepositoryIndexedOptions;
  ownerUserId?: string;
  repositoryStorageBytes?: number;
  maxIndexedRepositoriesPerUser?: number;
  maxStorageBytesPerUser?: number;
}

export interface RepositorySnapshotStore {
  begin(identity: RepositorySnapshotIdentity, signal?: AbortSignal): Promise<BeginRepositorySnapshotResult>;
  saveSummary(identity: RepositorySnapshotIdentity, summary: RepositorySummary, signal?: AbortSignal): Promise<void>;
  publish(input: PublishRepositorySnapshotInput, signal?: AbortSignal): Promise<void>;
  discard(identity: RepositorySnapshotIdentity, signal?: AbortSignal): Promise<void>;
}

interface RpcQuery extends PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }> { abortSignal?(signal: AbortSignal): RpcQuery }
interface DatabaseClient {
  rpc(name: string, parameters: Record<string, unknown>): RpcQuery;
}

async function rpc(client: DatabaseClient, name: string, parameters: Record<string, unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let query = client.rpc(name, parameters);
  if (signal && typeof query.abortSignal === "function") query = query.abortSignal(signal);
  return query;
}

function throwSnapshotError(
  error: { code?: string; message?: string } | null,
  fallbackMessage: string,
): void {
  if (!error) return;
  const quotaError = repositoryQuotaErrorFromMessage(error.message);
  if (quotaError) throw quotaError;
  if (error.code === "40001" || error.message === "indexing_job_lease_conflict") {
    throw new IndexingJobLeaseConflictError();
  }
  throw new Error(fallbackMessage);
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown> | undefined) ?? null;
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

function countsFromRow(row: Record<string, unknown>): IndexedCounts {
  return {
    chunkCount: Number(row.chunk_count ?? 0),
    fileCount: Number(row.file_count ?? 0),
    symbolCount: Number(row.symbol_count ?? 0),
    graphNodeCount: Number(row.graph_node_count ?? 0),
    graphEdgeCount: Number(row.graph_edge_count ?? 0),
    summaryAvailable: Boolean(row.summary_available),
  };
}

export class SupabaseRepositorySnapshotStore implements RepositorySnapshotStore {
  private readonly client: DatabaseClient;

  constructor(client: DatabaseClient | SupabaseClient) {
    this.client = client as DatabaseClient;
  }

  async begin(identity: RepositorySnapshotIdentity, signal?: AbortSignal): Promise<BeginRepositorySnapshotResult> {
    const { data, error } = await rpc(this.client, "begin_repository_snapshot", {
      input_repository_id: identity.repositoryId,
      input_revision: identity.revision,
      input_branch: identity.branch,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
    }, signal);
    throwSnapshotError(error, "Repository snapshot staging failed.");
    const row = firstRow(data);
    if (!row) throw new Error("Repository snapshot staging returned no state.");
    const alreadyPublished = row.already_published === true;
    return {
      alreadyPublished,
      counts: alreadyPublished ? countsFromRow(row) : null,
    };
  }

  async saveSummary(identity: RepositorySnapshotIdentity, summary: RepositorySummary, signal?: AbortSignal): Promise<void> {
    const { error } = await rpc(this.client, "save_repository_snapshot_summary", {
      input_repository_id: identity.repositoryId,
      input_revision: identity.revision,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
      input_summary: summary,
    }, signal);
    throwSnapshotError(error, "Repository snapshot summary persistence failed.");
  }

  async publish(input: PublishRepositorySnapshotInput, signal?: AbortSignal): Promise<void> {
    const quotaParameters = input.ownerUserId ? {
      input_owner_user_id: input.ownerUserId,
      input_repository_storage_bytes: input.repositoryStorageBytes ?? 0,
      input_max_indexed_repositories: input.maxIndexedRepositoriesPerUser ?? runtimeRepositoryQuotas.maxIndexedRepositoriesPerUser,
      input_max_user_storage_bytes: input.maxStorageBytesPerUser ?? runtimeRepositoryQuotas.maxStorageBytesPerUser,
    } : {};
    const { error } = await rpc(this.client, "publish_repository_snapshot", {
      input_repository_id: input.repositoryId,
      input_revision: input.revision,
      input_branch: input.branch,
      input_job_id: input.jobId,
      input_worker_id: input.workerId,
      input_claim_token: input.claimToken,
      input_chunk_count: input.counts.chunkCount,
      input_file_count: input.counts.fileCount,
      input_symbol_count: input.counts.symbolCount,
      input_graph_node_count: input.counts.graphNodeCount,
      input_graph_edge_count: input.counts.graphEdgeCount,
      input_summary_available: input.counts.summaryAvailable,
      input_embedding_version: input.embeddingVersion,
      input_intelligence_version: input.intelligenceVersion ?? null,
      input_index_mode: input.indexOptions?.indexMode ?? "full",
      input_changed_file_count: input.indexOptions?.changedFileCount ?? input.counts.fileCount,
      ...quotaParameters,
    }, signal);
    throwSnapshotError(error, "Repository snapshot publication failed.");
  }

  async discard(identity: RepositorySnapshotIdentity, signal?: AbortSignal): Promise<void> {
    const { error } = await rpc(this.client, "discard_repository_snapshot", {
      input_repository_id: identity.repositoryId,
      input_revision: identity.revision,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
    }, signal);
    throwSnapshotError(error, "Repository snapshot rollback failed.");
  }
}

export const runtimeRepositorySnapshotStore = new SupabaseRepositorySnapshotStore(supabase);
