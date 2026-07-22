import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../../config/env.js";
import type {
  HistoryPage,
  IntelligenceHistoryRecord,
  LifecycleHistoryRecord,
  RepositoryHistoryStore,
} from "./repositoryHistoryStore.js";

interface Result { data: unknown; error: { message?: string; code?: string } | null }
interface RpcQuery extends PromiseLike<Result> { abortSignal?(signal: AbortSignal): RpcQuery }
export interface RepositoryHistoryDatabaseClient {
  rpc(name: string, parameters?: Record<string, unknown>): RpcQuery;
}

function many<T>(data: unknown): T[] { return Array.isArray(data) ? data as T[] : []; }
function one<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return data && typeof data === "object" ? data as T : null;
}
function assertResult(error: Result["error"]): void {
  if (error) throw new Error(`Repository history persistence failed: ${error.message ?? error.code ?? "database error"}`);
}
async function rpc(client: RepositoryHistoryDatabaseClient, name: string,
  parameters: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
  signal?.throwIfAborted();
  let query = client.rpc(name, parameters);
  if (signal && query.abortSignal) query = query.abortSignal(signal);
  return query;
}

interface LifecycleRow {
  event_id: string; idempotency_key: string; repository_id: string; owner_id: string;
  repository_revision: string | null; event_type: string; event_payload: Record<string, unknown>;
  request_id: string | null; trace_id: string | null; created_at: string;
  ordering_key: number | string; retention_protected: boolean;
}
interface IntelligenceRow {
  intelligence_id: string; idempotency_key: string; repository_id: string; owner_id: string;
  repository_revision: string; intelligence_type: string; normalized_payload: unknown;
  model_name: string | null; provider_name: string | null; generated_at: string;
  ordering_key: number | string; retention_protected: boolean;
}
function lifecycle(row: LifecycleRow): LifecycleHistoryRecord {
  return {
    eventId: row.event_id, idempotencyKey: row.idempotency_key,
    repositoryId: row.repository_id, ownerId: row.owner_id,
    repositoryRevision: row.repository_revision, eventType: row.event_type,
    payload: row.event_payload, requestId: row.request_id, traceId: row.trace_id,
    createdAt: row.created_at, orderingKey: Number(row.ordering_key),
    retentionProtected: row.retention_protected,
  };
}
function intelligence(row: IntelligenceRow): IntelligenceHistoryRecord {
  return {
    recordId: row.intelligence_id, idempotencyKey: row.idempotency_key,
    repositoryId: row.repository_id, ownerId: row.owner_id,
    repositoryRevision: row.repository_revision, intelligenceType: row.intelligence_type,
    payload: row.normalized_payload, model: row.model_name, provider: row.provider_name,
    generatedAt: row.generated_at, orderingKey: Number(row.ordering_key),
    retentionProtected: row.retention_protected,
  };
}

export class SupabaseRepositoryHistoryStore implements RepositoryHistoryStore {
  private readonly client: RepositoryHistoryDatabaseClient;
  constructor(client: RepositoryHistoryDatabaseClient | SupabaseClient) {
    this.client = client as unknown as RepositoryHistoryDatabaseClient;
  }

  async insertLifecycle(record: Omit<LifecycleHistoryRecord, "orderingKey">): Promise<LifecycleHistoryRecord> {
    const { data, error } = await rpc(this.client, "insert_repository_lifecycle_event", {
      input_event_id: record.eventId, input_idempotency_key: record.idempotencyKey,
      input_repository_id: record.repositoryId, input_owner_id: record.ownerId,
      input_repository_revision: record.repositoryRevision, input_event_type: record.eventType,
      input_event_payload: record.payload, input_request_id: record.requestId,
      input_trace_id: record.traceId, input_created_at: record.createdAt,
      input_retention_protected: record.retentionProtected,
      input_statement_timeout_ms: env.DATABASE_STATEMENT_TIMEOUT_MS,
    });
    assertResult(error);
    const row = one<LifecycleRow>(data);
    if (!row) throw new Error("Repository lifecycle insertion returned no record.");
    return lifecycle(row);
  }

  async listLifecycle(input: Parameters<RepositoryHistoryStore["listLifecycle"]>[0]): Promise<HistoryPage<LifecycleHistoryRecord>> {
    const { data, error } = await rpc(this.client, "list_repository_lifecycle_events", {
      input_repository_id: input.repositoryId, input_owner_id: input.ownerId,
      input_repository_revision: input.revision ?? null, input_event_type: input.eventType ?? null,
      input_cursor_ordering_key: input.cursor?.orderingKey ?? null,
      input_cursor_record_id: input.cursor?.recordId ?? null, input_page_size: input.limit + 1,
      input_statement_timeout_ms: env.DATABASE_STATEMENT_TIMEOUT_MS,
    });
    assertResult(error);
    const rows = many<LifecycleRow>(data);
    const records = rows.slice(0, input.limit).map(lifecycle);
    const last = rows.length > input.limit ? records.at(-1) : undefined;
    return { records, nextCursor: last ? { orderingKey: last.orderingKey, recordId: last.eventId } : null };
  }

  async insertIntelligence(record: Omit<IntelligenceHistoryRecord, "orderingKey">): Promise<IntelligenceHistoryRecord> {
    const { data, error } = await rpc(this.client, "insert_repository_intelligence_history", {
      input_intelligence_id: record.recordId, input_idempotency_key: record.idempotencyKey,
      input_repository_id: record.repositoryId, input_owner_id: record.ownerId,
      input_repository_revision: record.repositoryRevision,
      input_intelligence_type: record.intelligenceType, input_normalized_payload: record.payload,
      input_model_name: record.model, input_provider_name: record.provider,
      input_generated_at: record.generatedAt, input_retention_protected: record.retentionProtected,
      input_statement_timeout_ms: env.DATABASE_STATEMENT_TIMEOUT_MS,
    });
    assertResult(error);
    const row = one<IntelligenceRow>(data);
    if (!row) throw new Error("Repository intelligence insertion returned no record.");
    return intelligence(row);
  }

  async listIntelligence(input: Parameters<RepositoryHistoryStore["listIntelligence"]>[0]): Promise<HistoryPage<IntelligenceHistoryRecord>> {
    const { data, error } = await rpc(this.client, "list_repository_intelligence_history", {
      input_repository_id: input.repositoryId, input_owner_id: input.ownerId,
      input_repository_revision: input.revision ?? null,
      input_intelligence_type: input.intelligenceType ?? null,
      input_cursor_ordering_key: input.cursor?.orderingKey ?? null,
      input_cursor_record_id: input.cursor?.recordId ?? null, input_page_size: input.limit + 1,
      input_statement_timeout_ms: env.DATABASE_STATEMENT_TIMEOUT_MS,
    });
    assertResult(error);
    const rows = many<IntelligenceRow>(data);
    const records = rows.slice(0, input.limit).map(intelligence);
    const last = rows.length > input.limit ? records.at(-1) : undefined;
    return { records, nextCursor: last ? { orderingKey: last.orderingKey, recordId: last.recordId } : null };
  }

  async cleanup(input: { maxRecordsPerType: number; maxAgeMs: number }, signal?: AbortSignal): Promise<number> {
    const { data, error } = await rpc(this.client, "cleanup_repository_history", {
      input_max_records_per_type: input.maxRecordsPerType, input_max_age_ms: input.maxAgeMs,
      input_statement_timeout_ms: env.DATABASE_STATEMENT_TIMEOUT_MS,
    }, signal);
    assertResult(error);
    return Number(data ?? 0);
  }
  async verifyPersistence(signal?: AbortSignal): Promise<void> {
    const { data, error } = await rpc(this.client, "verify_repository_history_contract", {
      input_statement_timeout_ms: env.DATABASE_STATEMENT_TIMEOUT_MS,
    }, signal);
    if (error || data !== true) throw new Error(error?.message ?? "Repository history contract is unavailable.");
  }
  async deleteRepository(): Promise<void> { /* Cascades from repositories in PostgreSQL. */ }
  clear(): never { throw new Error("Clearing durable repository history is not supported at runtime."); }
}
