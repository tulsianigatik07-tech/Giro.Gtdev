import type { SupabaseClient } from "@supabase/supabase-js";
import {
  repositoryRecordToRow,
  repositoryRowToRecord,
  type RepositoryPersistenceRow,
} from "./repositoryPersistenceMapper.js";
import type {
  ConnectRepositoryInput,
  MarkFailedInput,
  MarkIndexedInput,
  RepositoryRecord,
  RepositoryStore,
  UpdateRepositoryInput,
} from "./repositoryStore.js";

interface Result { data: unknown; error: { code?: string; message?: string } | null }
interface Query extends PromiseLike<Result> {
  select(columns?: string): Query;
  insert(values: unknown): Query;
  update(values: unknown): Query;
  delete(): Query;
  eq(column: string, value: unknown): Query;
  order(column: string, options?: { ascending?: boolean }): Query;
  maybeSingle(): PromiseLike<Result>;
}
export interface RepositoryDatabaseClient { from(table: string): Query }

function row(data: unknown): RepositoryPersistenceRow | null {
  if (Array.isArray(data)) return (data[0] as RepositoryPersistenceRow | undefined) ?? null;
  return data && typeof data === "object" ? data as RepositoryPersistenceRow : null;
}
function rows(data: unknown): RepositoryPersistenceRow[] {
  return Array.isArray(data) ? data as RepositoryPersistenceRow[] : [];
}
function assertResult(error: Result["error"]): void {
  if (error) throw new Error(`Repository persistence failed: ${error.message ?? error.code ?? "database error"}`);
}

export class SupabaseRepositoryStore implements RepositoryStore {
  private readonly client: RepositoryDatabaseClient;

  constructor(client: RepositoryDatabaseClient | SupabaseClient) {
    this.client = client as unknown as RepositoryDatabaseClient;
  }

  async connectRepository(input: ConnectRepositoryInput): Promise<RepositoryRecord> {
    const id = `${input.owner}/${input.repo}`;
    const existing = await this.getRepository(id);
    const timestamp = new Date().toISOString();
    if (existing) {
      const updated = await this.updateRepository(id, {
        ownerUserId: input.ownerUserId ?? existing.ownerUserId,
      });
      if (!updated) throw new Error("Repository disappeared during persistence update.");
      return updated;
    }
    const record: RepositoryRecord = {
      repositoryId: id, owner: input.owner, repo: input.repo,
      ownerUserId: input.ownerUserId ?? null, status: "connected",
      connectedAt: timestamp, updatedAt: timestamp, indexedAt: null,
      firstIndexedAt: null, lastIndexedAt: null, lastAccessedAt: null,
      chunkCount: 0, fileCount: 0, symbolCount: 0, graphNodeCount: 0,
      graphEdgeCount: 0, summaryAvailable: false, totalIndexedFiles: 0,
      lastIndexMode: null, lastChangedFileCount: 0, lastFailureAt: null,
      failureReason: null, failedFileCount: 0, lastSuccessfulFile: null,
      retryCount: 0, lastRetryAt: null, indexedRevision: null,
      lastLifecycleSeverity: null, lastReindexMode: null, lastReindexReason: null,
    };
    const { data, error } = await this.client.from("repositories")
      .insert(repositoryRecordToRow(record)).select("*").maybeSingle();
    assertResult(error);
    const persisted = row(data);
    if (!persisted) throw new Error("Repository persistence returned no record.");
    return repositoryRowToRecord(persisted);
  }

  async getRepository(repositoryId: string): Promise<RepositoryRecord | null> {
    const { data, error } = await this.client.from("repositories").select("*")
      .eq("repository_id", repositoryId).maybeSingle();
    if (error?.code === "PGRST116") return null;
    assertResult(error);
    const persisted = row(data);
    return persisted ? repositoryRowToRecord(persisted) : null;
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    const { data, error } = await this.client.from("repositories").select("*")
      .order("repository_owner", { ascending: true })
      .order("repository_name", { ascending: true });
    assertResult(error);
    return rows(data).map(repositoryRowToRecord);
  }

  async updateRepository(repositoryId: string, input: UpdateRepositoryInput): Promise<RepositoryRecord | null> {
    const existing = await this.getRepository(repositoryId);
    if (!existing) return null;
    const merged: RepositoryRecord = {
      ...existing,
      ...(Object.prototype.hasOwnProperty.call(input, "ownerUserId") ? { ownerUserId: input.ownerUserId ?? null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "indexedAt") ? { indexedAt: input.indexedAt ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "firstIndexedAt") ? { firstIndexedAt: input.firstIndexedAt ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "lastIndexedAt") ? { lastIndexedAt: input.lastIndexedAt ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "lastAccessedAt") ? { lastAccessedAt: input.lastAccessedAt ?? null } : {}),
      ...(input.totalIndexedFiles !== undefined ? { totalIndexedFiles: input.totalIndexedFiles } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "lastIndexMode") ? { lastIndexMode: input.lastIndexMode ?? null } : {}),
      ...(input.lastChangedFileCount !== undefined ? { lastChangedFileCount: input.lastChangedFileCount } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "lastFailureAt") ? { lastFailureAt: input.lastFailureAt ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "failureReason") ? { failureReason: input.failureReason ?? null } : {}),
      ...(input.failedFileCount !== undefined ? { failedFileCount: input.failedFileCount } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "lastSuccessfulFile") ? { lastSuccessfulFile: input.lastSuccessfulFile ?? null } : {}),
      ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "lastRetryAt") ? { lastRetryAt: input.lastRetryAt ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "indexedRevision") ? { indexedRevision: input.indexedRevision ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "lastLifecycleSeverity") ? { lastLifecycleSeverity: input.lastLifecycleSeverity ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "lastReindexMode") ? { lastReindexMode: input.lastReindexMode ?? null } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "lastReindexReason") ? { lastReindexReason: input.lastReindexReason ?? null } : {}),
      ...input.counts,
      updatedAt: new Date().toISOString(),
    };
    const { data, error } = await this.client.from("repositories")
      .update(repositoryRecordToRow(merged)).eq("repository_id", repositoryId)
      .select("*").maybeSingle();
    assertResult(error);
    const persisted = row(data);
    return persisted ? repositoryRowToRecord(persisted) : null;
  }

  async deleteRepository(repositoryId: string): Promise<boolean> {
    const existing = await this.getRepository(repositoryId);
    if (!existing) return false;
    const { error } = await this.client.from("repositories").delete().eq("repository_id", repositoryId);
    assertResult(error);
    return true;
  }
  async markIndexing(id: string) {
    const existing = await this.getRepository(id);
    if (!existing) return null;
    return this.updateRepository(id, {
      status: existing.indexedRevision ? "indexed" : "indexing",
    });
  }
  async markIndexed(id: string, input: MarkIndexedInput) {
    const existing = await this.getRepository(id); if (!existing) return null;
    const timestamp = new Date().toISOString();
    return this.updateRepository(id, { status: "indexed", indexedAt: timestamp,
      firstIndexedAt: existing.firstIndexedAt ?? timestamp, lastIndexedAt: timestamp,
      totalIndexedFiles: input.counts.fileCount, lastIndexMode: input.indexMode,
      lastChangedFileCount: input.changedFileCount, indexedRevision: input.indexedRevision,
      counts: input.counts });
  }
  async markFailed(id: string, input: MarkFailedInput = {}) {
    const existing = await this.getRepository(id);
    if (!existing) return null;
    return this.updateRepository(id, { status: existing.indexedRevision ? "indexed" : "failed", lastFailureAt: new Date().toISOString(),
      failureReason: input.reason, failedFileCount: input.failedFileCount,
      lastSuccessfulFile: input.lastSuccessfulFile });
  }
  touchAccess(id: string) { return this.updateRepository(id, { lastAccessedAt: new Date().toISOString() }); }
  async repositoryExists(id: string) { return (await this.getRepository(id)) !== null; }
  clear(): never { throw new Error("Clearing durable repository storage is not supported at runtime."); }
}
