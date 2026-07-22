import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MemoryRepositoryHistoryStore } from "../services/repository/history/memoryRepositoryHistoryStore.js";
import { SupabaseRepositoryHistoryStore } from "../services/repository/history/supabaseRepositoryHistoryStore.js";
import type {
  IntelligenceHistoryRecord,
  LifecycleHistoryRecord,
} from "../services/repository/history/repositoryHistoryStore.js";

function lifecycle(overrides: Partial<Omit<LifecycleHistoryRecord, "orderingKey">> = {}) {
  return {
    eventId: "event-1", idempotencyKey: "request-1", repositoryId: "acme/demo",
    ownerId: "user-a", repositoryRevision: "rev-a", eventType: "repository_indexed",
    payload: { message: "indexed", metadata: { files: 2 } }, requestId: "request-1",
    traceId: "trace-1", createdAt: "2026-01-02T00:00:00.000Z",
    retentionProtected: false, ...overrides,
  };
}
function intelligence(overrides: Partial<Omit<IntelligenceHistoryRecord, "orderingKey">> = {}) {
  return {
    recordId: "intel-1", idempotencyKey: "worker-1", repositoryId: "acme/demo",
    ownerId: "user-a", repositoryRevision: "rev-a", intelligenceType: "repository_intelligence",
    payload: { score: 90 }, model: "model-a", provider: "provider-a",
    generatedAt: "2026-01-02T00:00:00.000Z", retentionProtected: false, ...overrides,
  };
}

test("lifecycle and intelligence persist with owner, revision, correlation, and model metadata", () => {
  const store = new MemoryRepositoryHistoryStore();
  const event = store.insertLifecycle(lifecycle());
  const report = store.insertIntelligence(intelligence());
  assert.equal(event.ownerId, "user-a");
  assert.equal(event.repositoryRevision, "rev-a");
  assert.equal(event.requestId, "request-1");
  assert.equal(report.model, "model-a");
  assert.equal(report.provider, "provider-a");
  assert.ok(report.orderingKey > event.orderingKey);
});

test("owner-filtered cursor pages are deterministic and revision isolated", () => {
  const store = new MemoryRepositoryHistoryStore();
  store.insertLifecycle(lifecycle());
  store.insertLifecycle(lifecycle({ eventId: "event-2", idempotencyKey: "request-2" }));
  store.insertLifecycle(lifecycle({ eventId: "event-3", idempotencyKey: "request-3", repositoryRevision: "rev-b" }));
  store.insertLifecycle(lifecycle({ eventId: "foreign", idempotencyKey: "foreign", ownerId: "user-b" }));
  const first = store.listLifecycle({ repositoryId: "acme/demo", ownerId: "user-a", revision: "rev-a", limit: 1 });
  assert.deepEqual(first.records.map((item) => item.eventId), ["event-1"]);
  assert.ok(first.nextCursor);
  const second = store.listLifecycle({ repositoryId: "acme/demo", ownerId: "user-a",
    revision: "rev-a", cursor: first.nextCursor!, limit: 1 });
  assert.deepEqual(second.records.map((item) => item.eventId), ["event-2"]);
  assert.equal(second.nextCursor, null);
});

test("retries and concurrent worker replay deduplicate lifecycle and intelligence records", async () => {
  const store = new MemoryRepositoryHistoryStore();
  const events = await Promise.all(Array.from({ length: 8 }, () => store.insertLifecycle(lifecycle())));
  const reports = await Promise.all(Array.from({ length: 8 }, () => store.insertIntelligence(intelligence())));
  assert.equal(new Set(events.map((item) => item.eventId)).size, 1);
  assert.equal(new Set(reports.map((item) => item.recordId)).size, 1);
  assert.equal(store.listLifecycle({ repositoryId: "acme/demo", ownerId: "user-a", limit: 10 }).records.length, 1);
  assert.equal(store.listIntelligence({ repositoryId: "acme/demo", ownerId: "user-a", limit: 10 }).records.length, 1);
});

test("bounded and age cleanup is idempotent, concurrency-safe, and preserves protected audit records", async () => {
  let now = Date.parse("2026-02-01T00:00:00.000Z");
  const store = new MemoryRepositoryHistoryStore(() => now);
  for (let index = 0; index < 4; index += 1) {
    store.insertLifecycle(lifecycle({ eventId: `event-${index}`, idempotencyKey: `request-${index}`,
      createdAt: index === 0 ? "2025-01-01T00:00:00.000Z" : `2026-01-${27 + index}T00:00:00.000Z` }));
  }
  store.insertLifecycle(lifecycle({ eventId: "audit", idempotencyKey: "audit",
    createdAt: "2025-01-01T00:00:00.000Z", retentionProtected: true }));
  const removed = await Promise.all([
    store.cleanup({ maxRecordsPerType: 2, maxAgeMs: 10 * 86_400_000 }),
    store.cleanup({ maxRecordsPerType: 2, maxAgeMs: 10 * 86_400_000 }),
  ]);
  assert.equal(removed[0]! + removed[1]!, 2);
  const remaining = store.listLifecycle({ repositoryId: "acme/demo", ownerId: "user-a", limit: 10 }).records;
  assert.equal(remaining.some((item) => item.eventId === "audit"), true);
  assert.equal(remaining.filter((item) => !item.retentionProtected).length, 2);
  assert.equal(await store.cleanup({ maxRecordsPerType: 2, maxAgeMs: 10 * 86_400_000 }), 0);
  now += 1;
});

test("repository deletion cascades all history while tombstone audit ownership remains external", () => {
  const store = new MemoryRepositoryHistoryStore();
  store.insertLifecycle(lifecycle({ retentionProtected: true }));
  store.insertIntelligence(intelligence({ retentionProtected: true }));
  store.deleteRepository("acme/demo");
  assert.deepEqual(store.listLifecycle({ repositoryId: "acme/demo", ownerId: "user-a", limit: 10 }).records, []);
  assert.deepEqual(store.listIntelligence({ repositoryId: "acme/demo", ownerId: "user-a", limit: 10 }).records, []);
});

test("restarted Supabase adapters and multiple replicas share RPC-backed state with owner filters", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const rows = [{
    event_id: "event-1", idempotency_key: "request-1", repository_id: "acme/demo",
    owner_id: "user-a", repository_revision: "rev-a", event_type: "repository_indexed",
    event_payload: { message: "indexed" }, request_id: "request-1", trace_id: "trace-1",
    created_at: "2026-01-02T00:00:00.000Z", ordering_key: 1, retention_protected: false,
  }];
  const client = { rpc: (name: string, input: Record<string, unknown> = {}) => {
    calls.push({ name, input });
    return Promise.resolve({ data: name.startsWith("list_") || name.startsWith("insert_") ? rows : true, error: null });
  } };
  const replicaA = new SupabaseRepositoryHistoryStore(client);
  const replicaB = new SupabaseRepositoryHistoryStore(client);
  const inserted = await replicaA.insertLifecycle(lifecycle());
  const listed = await replicaB.listLifecycle({ repositoryId: "acme/demo", ownerId: "user-a", limit: 10 });
  assert.equal(listed.records[0]?.eventId, inserted.eventId);
  assert.equal(calls.at(-1)?.input.input_repository_id, "acme/demo");
  assert.equal(calls.at(-1)?.input.input_owner_id, "user-a");
  await replicaA.verifyPersistence();
  assert.equal(calls.at(-1)?.name, "verify_repository_history_contract");
});

test("memory and Supabase lifecycle adapters expose equivalent records", async () => {
  const memory = new MemoryRepositoryHistoryStore();
  const expected = memory.insertLifecycle(lifecycle());
  const row = {
    event_id: expected.eventId, idempotency_key: expected.idempotencyKey,
    repository_id: expected.repositoryId, owner_id: expected.ownerId,
    repository_revision: expected.repositoryRevision, event_type: expected.eventType,
    event_payload: expected.payload, request_id: expected.requestId, trace_id: expected.traceId,
    created_at: expected.createdAt, ordering_key: expected.orderingKey,
    retention_protected: expected.retentionProtected,
  };
  const supabase = new SupabaseRepositoryHistoryStore({ rpc: () => Promise.resolve({ data: [row], error: null }) });
  assert.deepEqual(await supabase.insertLifecycle(lifecycle()), expected);
});

test("memory and Supabase intelligence adapters preserve revision and normalized payload", async () => {
  const memory = new MemoryRepositoryHistoryStore();
  const expected = memory.insertIntelligence(intelligence());
  const row = {
    intelligence_id: expected.recordId, idempotency_key: expected.idempotencyKey,
    repository_id: expected.repositoryId, owner_id: expected.ownerId,
    repository_revision: expected.repositoryRevision, intelligence_type: expected.intelligenceType,
    normalized_payload: expected.payload, model_name: expected.model, provider_name: expected.provider,
    generated_at: expected.generatedAt, ordering_key: expected.orderingKey,
    retention_protected: expected.retentionProtected,
  };
  const calls: Array<Record<string, unknown>> = [];
  const supabase = new SupabaseRepositoryHistoryStore({ rpc: (_name: string, input: Record<string, unknown> = {}) => {
    calls.push(input); return Promise.resolve({ data: [row], error: null });
  } });
  assert.deepEqual(await supabase.insertIntelligence(intelligence()), expected);
  await supabase.listIntelligence({ repositoryId: "acme/demo", ownerId: "user-a",
    revision: "rev-a", intelligenceType: "repository_intelligence", limit: 10 });
  assert.equal(calls.at(-1)?.input_owner_id, "user-a");
  assert.equal(calls.at(-1)?.input_repository_revision, "rev-a");
});

test("startup and migration contracts validate durable tables, indexes, RPCs, RLS, grants, and cascade", async () => {
  const [startup, migration, lifecycleSource, intelligenceSource] = await Promise.all([
    readFile(new URL("../index.ts", import.meta.url), "utf8"),
    readFile(new URL("../../supabase/migrations/20260801000000_add_durable_repository_history.sql", import.meta.url), "utf8"),
    readFile(new URL("../services/repository/repositoryLifecycleEvents.ts", import.meta.url), "utf8"),
    readFile(new URL("../services/repository/repositoryIntelligenceHistory.ts", import.meta.url), "utf8"),
  ]);
  for (const contract of ["repository_lifecycle_events", "repository_intelligence_history",
    "on delete cascade", "unique(repository_id, idempotency_key)",
    "repository_lifecycle_owner_pagination_idx", "repository_intelligence_revision_pagination_idx",
    "insert_repository_lifecycle_event", "insert_repository_intelligence_history",
    "cleanup_repository_history", "pg_advisory_xact_lock", "retention_protected",
    "enable row level security", "revoke all", "verify_repository_history_contract"])
    assert.match(migration, new RegExp(contract.replace(/[()]/g, "\\$&"), "i"));
  assert.match(startup, /repositoryHistoryStore\.verifyPersistence/);
  assert.match(startup, /REPOSITORY_HISTORY_MAX_RECORDS_PER_TYPE/);
  assert.doesNotMatch(lifecycleSource, /const\s+events\s*=\s*\[/);
  assert.doesNotMatch(intelligenceSource, /new Map/);
});
