import type { MaybePromise } from "../../../lib/maybePromise.js";

export interface HistoryCursor {
  orderingKey: number;
  recordId: string;
}

export interface LifecycleHistoryRecord {
  eventId: string;
  idempotencyKey: string;
  repositoryId: string;
  ownerId: string;
  repositoryRevision: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  requestId: string | null;
  traceId: string | null;
  createdAt: string;
  orderingKey: number;
  retentionProtected: boolean;
}

export interface IntelligenceHistoryRecord {
  recordId: string;
  idempotencyKey: string;
  repositoryId: string;
  ownerId: string;
  repositoryRevision: string;
  intelligenceType: string;
  payload: unknown;
  model: string | null;
  provider: string | null;
  generatedAt: string;
  orderingKey: number;
  retentionProtected: boolean;
}

export interface HistoryPage<T> {
  records: T[];
  nextCursor: HistoryCursor | null;
}

export interface RepositoryHistoryStore {
  insertLifecycle(record: Omit<LifecycleHistoryRecord, "orderingKey">): MaybePromise<LifecycleHistoryRecord>;
  listLifecycle(input: {
    repositoryId: string;
    ownerId: string;
    revision?: string;
    eventType?: string;
    cursor?: HistoryCursor;
    limit: number;
  }): MaybePromise<HistoryPage<LifecycleHistoryRecord>>;
  listAllLifecycleForTests?(): LifecycleHistoryRecord[];
  insertIntelligence(record: Omit<IntelligenceHistoryRecord, "orderingKey">): MaybePromise<IntelligenceHistoryRecord>;
  listIntelligence(input: {
    repositoryId: string;
    ownerId: string;
    revision?: string;
    intelligenceType?: string;
    cursor?: HistoryCursor;
    limit: number;
  }): MaybePromise<HistoryPage<IntelligenceHistoryRecord>>;
  cleanup(input: { maxRecordsPerType: number; maxAgeMs: number }, signal?: AbortSignal): Promise<number>;
  verifyPersistence(signal?: AbortSignal): Promise<void>;
  deleteRepository(repositoryId: string): MaybePromise<void>;
  deleteIntelligenceForTests?(repositoryId: string, intelligenceType: string): void;
  clear(): MaybePromise<void>;
}
