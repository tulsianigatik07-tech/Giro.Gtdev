import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../../../lib/supabase.js";
import type { IndexedCounts, SetRepositoryIndexedOptions } from "../../repository/indexingService.js";
import type { RepositorySummary } from "../../repositorySummary/summaryTypes.js";
import { IndexingJobLeaseConflictError } from "../jobs/indexingJobStore.js";

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
  indexOptions?: SetRepositoryIndexedOptions;
}

export interface RepositorySnapshotStore {
  begin(identity: RepositorySnapshotIdentity): Promise<BeginRepositorySnapshotResult>;
  saveSummary(identity: RepositorySnapshotIdentity, summary: RepositorySummary): Promise<void>;
  publish(input: PublishRepositorySnapshotInput): Promise<void>;
  discard(identity: RepositorySnapshotIdentity): Promise<void>;
}

interface DatabaseClient {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

function throwSnapshotError(
  error: { code?: string; message?: string } | null,
  fallbackMessage: string,
): void {
  if (!error) return;
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

  async begin(identity: RepositorySnapshotIdentity): Promise<BeginRepositorySnapshotResult> {
    const { data, error } = await this.client.rpc("begin_repository_snapshot", {
      input_repository_id: identity.repositoryId,
      input_revision: identity.revision,
      input_branch: identity.branch,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
    });
    throwSnapshotError(error, "Repository snapshot staging failed.");
    const row = firstRow(data);
    if (!row) throw new Error("Repository snapshot staging returned no state.");
    const alreadyPublished = row.already_published === true;
    return {
      alreadyPublished,
      counts: alreadyPublished ? countsFromRow(row) : null,
    };
  }

  async saveSummary(identity: RepositorySnapshotIdentity, summary: RepositorySummary): Promise<void> {
    const { error } = await this.client.rpc("save_repository_snapshot_summary", {
      input_repository_id: identity.repositoryId,
      input_revision: identity.revision,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
      input_summary: summary,
    });
    throwSnapshotError(error, "Repository snapshot summary persistence failed.");
  }

  async publish(input: PublishRepositorySnapshotInput): Promise<void> {
    const { error } = await this.client.rpc("publish_repository_snapshot", {
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
      input_index_mode: input.indexOptions?.indexMode ?? "full",
      input_changed_file_count: input.indexOptions?.changedFileCount ?? input.counts.fileCount,
    });
    throwSnapshotError(error, "Repository snapshot publication failed.");
  }

  async discard(identity: RepositorySnapshotIdentity): Promise<void> {
    const { error } = await this.client.rpc("discard_repository_snapshot", {
      input_repository_id: identity.repositoryId,
      input_revision: identity.revision,
      input_job_id: identity.jobId,
      input_worker_id: identity.workerId,
      input_claim_token: identity.claimToken,
    });
    throwSnapshotError(error, "Repository snapshot rollback failed.");
  }
}

export const runtimeRepositorySnapshotStore = new SupabaseRepositorySnapshotStore(supabase);
