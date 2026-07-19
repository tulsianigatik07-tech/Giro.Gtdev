import type { SupabaseClient } from "@supabase/supabase-js";

import {
  transitionIndexingJob,
  validateIndexingJobProgress,
} from "./indexingJobLifecycle.js";
import {
  indexingJobRowToDomain,
  indexingJobToUpdateRow,
  type IndexingJobPersistenceRow,
} from "./indexingJobPersistenceMapper.js";
import type {
  CreateIndexingJobInput,
  IndexingJob,
  IndexingJobFailure,
  IndexingJobListFilters,
  IndexingJobPatch,
  IndexingJobStage,
  IndexingJobStore,
} from "./indexingJobStore.js";

const TABLE = "indexing_jobs";
const DEFAULT_MAX_ATTEMPTS = 3;

export type IndexingJobPersistenceErrorCode =
  | "duplicate_active_job"
  | "job_not_found"
  | "invalid_transition"
  | "supabase_unavailable"
  | "database_failure";

export class IndexingJobPersistenceError extends Error {
  readonly code: IndexingJobPersistenceErrorCode;

  constructor(
    code: IndexingJobPersistenceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "IndexingJobPersistenceError";
    this.code = code;
  }
}

export interface SupabaseErrorLike {
  code?: string;
  message?: string;
}

export interface SupabaseQueryResult {
  data: unknown;
  error: SupabaseErrorLike | null;
}

export interface SupabaseIndexingJobQuery
  extends PromiseLike<SupabaseQueryResult> {
  select(columns?: string): SupabaseIndexingJobQuery;
  insert(values: unknown): SupabaseIndexingJobQuery;
  update(values: unknown): SupabaseIndexingJobQuery;
  delete(): SupabaseIndexingJobQuery;
  eq(column: string, value: unknown): SupabaseIndexingJobQuery;
  gte(column: string, value: unknown): SupabaseIndexingJobQuery;
  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ): SupabaseIndexingJobQuery;
  limit(count: number): SupabaseIndexingJobQuery;
  maybeSingle(): PromiseLike<SupabaseQueryResult>;
}

export interface SupabaseIndexingJobClient {
  from(table: string): SupabaseIndexingJobQuery;
  rpc(functionName: string, parameters?: Record<string, unknown>): PromiseLike<SupabaseQueryResult>;
}

export interface SupabaseIndexingJobStoreOptions {
  client: SupabaseIndexingJobClient | SupabaseClient;
}

function persistenceError(
  code: IndexingJobPersistenceErrorCode,
  cause?: unknown,
): IndexingJobPersistenceError {
  const messages: Record<IndexingJobPersistenceErrorCode, string> = {
    duplicate_active_job: "An active indexing job already exists.",
    job_not_found: "Indexing job was not found.",
    invalid_transition: "Indexing job update is invalid.",
    supabase_unavailable: "Indexing job persistence is unavailable.",
    database_failure: "Indexing job persistence failed.",
  };
  return new IndexingJobPersistenceError(code, messages[code], { cause });
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.toLowerCase() : "";
}

export function normalizeIndexingJobPersistenceError(
  error: unknown,
): IndexingJobPersistenceError {
  if (error instanceof IndexingJobPersistenceError) return error;

  const code = errorCode(error);
  const message = errorText(error);
  if (code === "23505") return persistenceError("duplicate_active_job", error);
  if (code === "PGRST116") return persistenceError("job_not_found", error);
  if (code === "23514" || code === "22P02" || code === "P0001") {
    return persistenceError("invalid_transition", error);
  }
  if (
    code.startsWith("08") ||
    code === "PGRST000" ||
    code === "PGRST001" ||
    code === "53300" ||
    code === "57P01" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("connection") ||
    message.includes("timeout")
  ) {
    return persistenceError("supabase_unavailable", error);
  }
  return persistenceError("database_failure", error);
}

function rowFromData(data: unknown): IndexingJobPersistenceRow | null {
  if (Array.isArray(data)) {
    return (data[0] as IndexingJobPersistenceRow | undefined) ?? null;
  }
  if (!data || typeof data !== "object") return null;
  return data as IndexingJobPersistenceRow;
}

function rowsFromData(data: unknown): IndexingJobPersistenceRow[] {
  return Array.isArray(data) ? data as IndexingJobPersistenceRow[] : [];
}

function isNotFoundError(error: SupabaseErrorLike | null): boolean {
  return error?.code === "PGRST116";
}

function throwIfError(error: SupabaseErrorLike | null): void {
  if (error) throw normalizeIndexingJobPersistenceError(error);
}

function cloneFailure(failure: IndexingJobFailure | null): IndexingJobFailure | null {
  return failure ? { ...failure } : null;
}

export class SupabaseIndexingJobStore implements IndexingJobStore {
  private readonly client: SupabaseIndexingJobClient;

  constructor(options: SupabaseIndexingJobStoreOptions) {
    this.client = options.client as unknown as SupabaseIndexingJobClient;
  }

  async createJob(input: CreateIndexingJobInput): Promise<IndexingJob> {
    try {
      const { data, error } = await this.client.rpc("create_indexing_job", {
        input_repository_id: input.repositoryId,
        input_owner_user_id: input.ownerUserId,
        input_repository_owner: input.repositoryOwner,
        input_repository_name: input.repositoryName,
        input_repository_url: input.repositoryUrl,
        input_branch: input.branch ?? null,
        input_max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        input_request_id: input.createdByRequestId ?? null,
      });
      throwIfError(error);
      const row = rowFromData(data);
      if (!row) throw persistenceError("database_failure");
      return indexingJobRowToDomain(row);
    } catch (error) {
      throw normalizeIndexingJobPersistenceError(error);
    }
  }

  async getJob(jobId: string): Promise<IndexingJob | null> {
    try {
      const { data, error } = await this.client
        .from(TABLE)
        .select("*")
        .eq("job_id", jobId)
        .maybeSingle();
      if (isNotFoundError(error)) return null;
      throwIfError(error);
      const row = rowFromData(data);
      return row ? indexingJobRowToDomain(row) : null;
    } catch (error) {
      if (error instanceof IndexingJobPersistenceError && error.code === "job_not_found") {
        return null;
      }
      throw normalizeIndexingJobPersistenceError(error);
    }
  }

  async listJobs(filters?: IndexingJobListFilters): Promise<IndexingJob[]> {
    try {
      let query = this.client.from(TABLE).select("*");
      if (filters?.status !== undefined) query = query.eq("status", filters.status);
      if (filters?.repositoryId !== undefined) {
        query = query.eq("repository_id", filters.repositoryId);
      }
      if (filters?.ownerUserId !== undefined) {
        query = query.eq("owner_user_id", filters.ownerUserId);
      }
      const { data, error } = await query
        .order("created_order", { ascending: true })
        .order("sequence", { ascending: true })
        .order("job_id", { ascending: true });
      throwIfError(error);
      return rowsFromData(data).map(indexingJobRowToDomain);
    } catch (error) {
      throw normalizeIndexingJobPersistenceError(error);
    }
  }

  async listRepositoryJobs(repositoryId: string): Promise<IndexingJob[]> {
    return this.listJobs({ repositoryId });
  }

  async getLatestRepositoryJob(repositoryId: string): Promise<IndexingJob | null> {
    try {
      const { data, error } = await this.client
        .from(TABLE)
        .select("*")
        .eq("repository_id", repositoryId)
        .order("created_order", { ascending: false })
        .order("sequence", { ascending: false })
        .order("job_id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (isNotFoundError(error)) return null;
      throwIfError(error);
      const row = rowFromData(data);
      return row ? indexingJobRowToDomain(row) : null;
    } catch (error) {
      if (error instanceof IndexingJobPersistenceError && error.code === "job_not_found") {
        return null;
      }
      throw normalizeIndexingJobPersistenceError(error);
    }
  }

  async claimNextJob(workerId: string): Promise<IndexingJob | null> {
    try {
      const { data, error } = await this.client.rpc("claim_next_indexing_job", {
        input_worker_id: workerId,
      });
      throwIfError(error);
      const row = rowFromData(data);
      return row ? indexingJobRowToDomain(row) : null;
    } catch (error) {
      throw normalizeIndexingJobPersistenceError(error);
    }
  }

  async updateJob(jobId: string, patch: IndexingJobPatch): Promise<IndexingJob | null> {
    const existing = await this.getJob(jobId);
    if (!existing) return null;

    const progress = patch.progress ?? existing.progress;
    if (validateIndexingJobProgress(existing, progress)) return null;

    const updated: IndexingJob = {
      ...existing,
      progress,
      currentStage: patch.currentStage ?? existing.currentStage,
      failure: patch.failure === undefined
        ? cloneFailure(existing.failure)
        : cloneFailure(patch.failure),
      maxAttempts: patch.maxAttempts ?? existing.maxAttempts,
    };
    return this.compareAndSet(existing, updated);
  }

  async markRunning(
    jobId: string,
    stage: IndexingJobStage = "clone",
  ): Promise<IndexingJob | null> {
    return this.transition(jobId, "running", { stage });
  }

  async updateProgress(
    jobId: string,
    progress: number,
    stage?: IndexingJobStage,
  ): Promise<IndexingJob | null> {
    return this.updateJob(jobId, { progress, currentStage: stage });
  }

  async markSucceeded(jobId: string): Promise<IndexingJob | null> {
    return this.transition(jobId, "succeeded");
  }

  async markFailed(
    jobId: string,
    failure: IndexingJobFailure,
  ): Promise<IndexingJob | null> {
    return this.transition(jobId, "failed", { failure });
  }

  async cancelJob(jobId: string): Promise<IndexingJob | null> {
    return this.transition(jobId, "cancelled");
  }

  async deleteJob(jobId: string): Promise<boolean> {
    try {
      const { data, error } = await this.client
        .from(TABLE)
        .delete()
        .eq("job_id", jobId)
        .select("job_id");
      throwIfError(error);
      return rowsFromData(data).length > 0;
    } catch (error) {
      throw normalizeIndexingJobPersistenceError(error);
    }
  }

  async clear(): Promise<void> {
    try {
      const { error } = await this.client
        .from(TABLE)
        .delete()
        .gte("sequence", 1);
      throwIfError(error);
    } catch (error) {
      throw normalizeIndexingJobPersistenceError(error);
    }
  }

  private async transition(
    jobId: string,
    nextStatus: IndexingJob["status"],
    options: { stage?: IndexingJobStage; failure?: IndexingJobFailure } = {},
  ): Promise<IndexingJob | null> {
    const existing = await this.getJob(jobId);
    if (!existing) return null;
    const transitioned = transitionIndexingJob(existing, nextStatus, options);
    if (!transitioned.ok) return null;
    return this.compareAndSet(existing, transitioned.job);
  }

  private async compareAndSet(
    existing: IndexingJob,
    updated: IndexingJob,
  ): Promise<IndexingJob | null> {
    try {
      const { data, error } = await this.client
        .from(TABLE)
        .update(indexingJobToUpdateRow(updated))
        .eq("job_id", existing.jobId)
        .eq("status", existing.status)
        .eq("progress", existing.progress)
        .select("*")
        .maybeSingle();
      if (isNotFoundError(error)) return null;
      throwIfError(error);
      const row = rowFromData(data);
      return row ? indexingJobRowToDomain(row) : null;
    } catch (error) {
      if (error instanceof IndexingJobPersistenceError && error.code === "job_not_found") {
        return null;
      }
      throw normalizeIndexingJobPersistenceError(error);
    }
  }
}
