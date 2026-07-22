import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../../config/env.js";
import { repositoryQuotaErrorFromMessage } from "../quotas/repositoryQuota.js";
import {
  indexingJobRowToDomain,
  type IndexingJobPersistenceRow,
} from "../../indexing/jobs/indexingJobPersistenceMapper.js";
import {
  RepositoryConnectionIdempotencyConflictError,
  throwIfConnectionAborted,
  type ConnectRepositoryTransactionInput,
  type RepositoryConnectionResponse,
  type RepositoryConnectionStore,
  type RepositoryConnectionTransactionResult,
} from "./repositoryConnectionStore.js";

interface Result {
  data: unknown;
  error: { code?: string; message?: string } | null;
}
interface AbortableRpc extends PromiseLike<Result> {
  abortSignal?(signal: AbortSignal): AbortableRpc;
}
interface DatabaseClient {
  rpc(name: string, parameters?: Record<string, unknown>): AbortableRpc;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown> | undefined) ?? null;
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

async function executeRpc(
  client: DatabaseClient,
  name: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Result> {
  throwIfConnectionAborted(signal);
  let query = client.rpc(name, parameters);
  if (signal && typeof query.abortSignal === "function") query = query.abortSignal(signal);
  return query;
}

export class SupabaseRepositoryConnectionStore implements RepositoryConnectionStore {
  private readonly client: DatabaseClient;

  constructor(client: DatabaseClient | SupabaseClient) {
    this.client = client as DatabaseClient;
  }

  async connect(input: ConnectRepositoryTransactionInput): Promise<RepositoryConnectionTransactionResult> {
    const { data, error } = await executeRpc(this.client, "connect_repository_idempotently", {
      input_idempotency_key: input.idempotencyKey,
      input_payload_hash: input.payloadHash,
      input_owner_user_id: input.ownerUserId,
      input_repository_owner: input.repositoryOwner,
      input_repository_name: input.repositoryName,
      input_repository_url: input.repositoryUrl,
      input_branch: input.branch,
      input_request_id: input.requestId,
      input_traceparent: input.traceparent,
      input_max_attempts: env.INDEXING_WORKER_MAX_ATTEMPTS,
      input_max_concurrent_per_user: env.REPOSITORY_QUOTA_MAX_CONCURRENT_PER_USER,
      input_retention_ms: env.REPOSITORY_CONNECTION_IDEMPOTENCY_RETENTION_MS,
      input_statement_timeout_ms: env.DATABASE_STATEMENT_TIMEOUT_MS,
    }, input.signal);
    if (error) {
      if (error.message?.includes("idempotency_conflict")) {
        throw new RepositoryConnectionIdempotencyConflictError();
      }
      const quota = repositoryQuotaErrorFromMessage(error.message);
      if (quota) throw quota;
      throw new Error(error.message ?? error.code ?? "Repository connection transaction failed.");
    }
    const row = firstRow(data);
    const response = row?.response;
    const job = row?.job;
    if (!response || typeof response !== "object" || !job || typeof job !== "object") {
      throw new Error("Repository connection transaction returned no result.");
    }
    return {
      response: structuredClone(response as RepositoryConnectionResponse),
      job: indexingJobRowToDomain(job as unknown as IndexingJobPersistenceRow),
      replayed: row.replayed === true,
    };
  }

  async cleanupExpired(signal?: AbortSignal): Promise<number> {
    const { data, error } = await executeRpc(this.client, "cleanup_repository_connection_idempotency", {
      input_statement_timeout_ms: env.DATABASE_STATEMENT_TIMEOUT_MS,
    }, signal);
    if (error) throw new Error(error.message ?? "Repository connection idempotency cleanup failed.");
    return Number(data ?? 0);
  }

  async verify(signal?: AbortSignal): Promise<void> {
    const { data, error } = await executeRpc(this.client, "verify_repository_connection_idempotency", {
      input_statement_timeout_ms: env.DATABASE_STATEMENT_TIMEOUT_MS,
    }, signal);
    if (error || data !== true) {
      throw new Error(error?.message ?? "Repository connection idempotency database objects are unavailable.");
    }
  }
}
