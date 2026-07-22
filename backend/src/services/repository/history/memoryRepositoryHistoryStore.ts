import type {
  HistoryCursor,
  HistoryPage,
  IntelligenceHistoryRecord,
  LifecycleHistoryRecord,
  RepositoryHistoryStore,
} from "./repositoryHistoryStore.js";

function copy<T>(value: T): T { return structuredClone(value); }

export class MemoryRepositoryHistoryStore implements RepositoryHistoryStore {
  private readonly lifecycle = new Map<string, LifecycleHistoryRecord>();
  private readonly intelligence = new Map<string, IntelligenceHistoryRecord>();
  private nextOrderingKey = 1;

  constructor(private readonly now: () => number = Date.now) {}

  insertLifecycle(record: Omit<LifecycleHistoryRecord, "orderingKey">): LifecycleHistoryRecord {
    const duplicate = [...this.lifecycle.values()].find((item) =>
      item.repositoryId === record.repositoryId && item.idempotencyKey === record.idempotencyKey);
    if (duplicate) return copy(duplicate);
    const stored = { ...copy(record), orderingKey: this.nextOrderingKey++ };
    this.lifecycle.set(stored.eventId, stored);
    return copy(stored);
  }

  listLifecycle(input: {
    repositoryId: string; ownerId: string; revision?: string; eventType?: string;
    cursor?: HistoryCursor; limit: number;
  }): HistoryPage<LifecycleHistoryRecord> {
    return this.page([...this.lifecycle.values()].filter((item) =>
      item.repositoryId === input.repositoryId && (item.ownerId === input.ownerId || item.ownerId === "*") &&
      (input.revision === undefined || item.repositoryRevision === input.revision) &&
      (input.eventType === undefined || item.eventType === input.eventType)), input.cursor, input.limit, "eventId");
  }

  listAllLifecycleForTests(): LifecycleHistoryRecord[] {
    return [...this.lifecycle.values()].sort((a, b) => a.orderingKey - b.orderingKey).map(copy);
  }

  insertIntelligence(record: Omit<IntelligenceHistoryRecord, "orderingKey">): IntelligenceHistoryRecord {
    const duplicate = [...this.intelligence.values()].find((item) =>
      item.repositoryId === record.repositoryId && item.intelligenceType === record.intelligenceType &&
      item.idempotencyKey === record.idempotencyKey);
    if (duplicate) return copy(duplicate);
    const stored = { ...copy(record), orderingKey: this.nextOrderingKey++ };
    this.intelligence.set(stored.recordId, stored);
    return copy(stored);
  }

  listIntelligence(input: {
    repositoryId: string; ownerId: string; revision?: string; intelligenceType?: string;
    cursor?: HistoryCursor; limit: number;
  }): HistoryPage<IntelligenceHistoryRecord> {
    return this.page([...this.intelligence.values()].filter((item) =>
      item.repositoryId === input.repositoryId && (item.ownerId === input.ownerId || item.ownerId === "*") &&
      (input.revision === undefined || item.repositoryRevision === input.revision) &&
      (input.intelligenceType === undefined || item.intelligenceType === input.intelligenceType)),
    input.cursor, input.limit, "recordId");
  }

  async cleanup(input: { maxRecordsPerType: number; maxAgeMs: number }, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    let removed = 0;
    const cutoff = this.now() - input.maxAgeMs;
    for (const [key, record] of this.lifecycle) {
      if (!record.retentionProtected && Date.parse(record.createdAt) < cutoff) {
        this.lifecycle.delete(key); removed += 1;
      }
    }
    for (const [key, record] of this.intelligence) {
      if (!record.retentionProtected && Date.parse(record.generatedAt) < cutoff) {
        this.intelligence.delete(key); removed += 1;
      }
    }
    removed += this.trim(this.lifecycle, (item) => `${item.repositoryId}:${item.eventType}`, input.maxRecordsPerType);
    removed += this.trim(this.intelligence, (item) => `${item.repositoryId}:${item.intelligenceType}`, input.maxRecordsPerType);
    return removed;
  }

  async verifyPersistence(signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); }
  deleteRepository(repositoryId: string): void {
    for (const [key, value] of this.lifecycle) if (value.repositoryId === repositoryId) this.lifecycle.delete(key);
    for (const [key, value] of this.intelligence) if (value.repositoryId === repositoryId) this.intelligence.delete(key);
  }
  deleteIntelligenceForTests(repositoryId: string, intelligenceType: string): void {
    for (const [key, value] of this.intelligence) {
      if (value.repositoryId === repositoryId && value.intelligenceType === intelligenceType) {
        this.intelligence.delete(key);
      }
    }
  }
  clear(): void { this.lifecycle.clear(); this.intelligence.clear(); this.nextOrderingKey = 1; }

  private page<T extends { orderingKey: number }>(records: T[], cursor: HistoryCursor | undefined,
    limit: number, idKey: "eventId" | "recordId"): HistoryPage<T> {
    const sorted = records.sort((a, b) => a.orderingKey - b.orderingKey ||
      String((a as unknown as Record<string, unknown>)[idKey]).localeCompare(String((b as unknown as Record<string, unknown>)[idKey])))
      .filter((item) => !cursor || item.orderingKey > cursor.orderingKey ||
        (item.orderingKey === cursor.orderingKey && String((item as unknown as Record<string, unknown>)[idKey]) > cursor.recordId));
    const hasMore = sorted.length > limit;
    const page = sorted.slice(0, limit).map(copy);
    const last = hasMore ? page.at(-1) : undefined;
    return { records: page, nextCursor: last ? {
      orderingKey: last.orderingKey,
      recordId: String((last as unknown as Record<string, unknown>)[idKey]),
    } : null };
  }

  private trim<T extends { orderingKey: number; retentionProtected: boolean }>(
    records: Map<string, T>, group: (record: T) => string, maximum: number,
  ): number {
    let removed = 0;
    const groups = new Map<string, Array<[string, T]>>();
    for (const entry of records) groups.set(group(entry[1]), [...(groups.get(group(entry[1])) ?? []), entry]);
    for (const entries of groups.values()) {
      const removable = entries.filter(([, item]) => !item.retentionProtected)
        .sort((a, b) => b[1].orderingKey - a[1].orderingKey).slice(maximum);
      for (const [key] of removable) { records.delete(key); removed += 1; }
    }
    return removed;
  }
}
