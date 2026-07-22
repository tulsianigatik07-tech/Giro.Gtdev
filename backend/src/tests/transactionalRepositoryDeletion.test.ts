import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { indexingJobClaim } from "../services/indexing/jobs/indexingJobStore.js";
import { RepositoryDeletionService } from "../services/repository/repositoryDeletionService.js";
import type { RepositoryCleanupReport } from "../services/repository/repositoryCleanupReport.js";
import { MemoryRepositoryStore } from "../services/repository/store/memoryRepositoryStore.js";
import { SupabaseRepositoryStore } from "../services/repository/store/supabaseRepositoryStore.js";
import { removeRepositoryCheckout } from "../services/security/repositoryPaths.js";

const REPORT: RepositoryCleanupReport = {
  repositoryId: "acme/demo",
  success: true,
  summary: { totalExecuted: 0, totalSkipped: 0 },
  executedResources: [],
  skippedResources: [],
  warnings: [],
  statistics: { executionCoverage: 1, unsupportedResources: 0, completionPercentage: 100 },
};

function setup(removeCheckout: (repositoryId: string) => Promise<boolean>) {
  const repositories = new MemoryRepositoryStore();
  const jobs = new MemoryIndexingJobStore();
  const repository = repositories.connectRepository({ owner: "acme", repo: "demo", ownerUserId: "user-1" });
  const service = new RepositoryDeletionService({
    repositoryStore: repositories,
    indexingJobStore: jobs,
    removeCheckout,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  return { repositories, jobs, repository, service };
}

test("durable deletion commits before filesystem cleanup and is idempotent", async () => {
  let calls = 0;
  const state = setup(async (repositoryId) => {
    calls += 1;
    assert.equal(state.repositories.getRepository(repositoryId), null);
    assert.ok(state.repositories.getDeletionTombstone(repositoryId));
    return true;
  });
  const first = await state.service.delete({
    repositoryId: state.repository.repositoryId,
    ownerUserId: "user-1",
    expectedVersion: state.repository.persistenceVersion ?? 1,
    report: REPORT,
  });
  const repeated = await state.service.delete({
    repositoryId: state.repository.repositoryId,
    ownerUserId: "user-1",
    expectedVersion: 999,
    report: REPORT,
  });
  assert.equal(first.tombstone.deletionState, "deleted");
  assert.equal(first.tombstone.cleanupPending, false);
  assert.equal(repeated.repeated, true);
  assert.deepEqual(repeated.report, REPORT);
  assert.equal(calls, 1);
});

test("durable failure rolls back without touching filesystem", async () => {
  class FailingStore extends MemoryRepositoryStore {
    override deleteRepositoryDurably(): never { throw new Error("database unavailable"); }
  }
  const repositories = new FailingStore();
  const jobs = new MemoryIndexingJobStore();
  const repository = repositories.connectRepository({ owner: "acme", repo: "demo", ownerUserId: "user-1" });
  let filesystemCalled = false;
  const service = new RepositoryDeletionService({
    repositoryStore: repositories,
    indexingJobStore: jobs,
    removeCheckout: async () => { filesystemCalled = true; return true; },
  });
  await assert.rejects(service.delete({
    repositoryId: repository.repositoryId,
    ownerUserId: "user-1",
    expectedVersion: repository.persistenceVersion ?? 1,
    report: REPORT,
  }), /database unavailable/);
  assert.ok(repositories.getRepository(repository.repositoryId));
  assert.equal(repositories.getDeletionTombstone(repository.repositoryId), null);
  assert.equal(filesystemCalled, false);
});

test("filesystem failure remains cleanup-pending and startup recovery retries", async () => {
  let attempts = 0;
  const state = setup(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("busy checkout");
    return true;
  });
  const deleted = await state.service.delete({
    repositoryId: state.repository.repositoryId,
    ownerUserId: "user-1",
    expectedVersion: state.repository.persistenceVersion ?? 1,
    report: REPORT,
  });
  assert.equal(deleted.tombstone.cleanupPending, true);
  assert.equal(state.repositories.getRepository(state.repository.repositoryId), null);
  assert.equal(await state.service.recoverPendingFilesystemCleanup(), 1);
  assert.equal(state.repositories.getDeletionTombstone(state.repository.repositoryId)?.cleanupPending, false);
  assert.equal(attempts, 2);
});

test("deletion fences active and stale workers and prevents future indexing", async () => {
  const state = setup(async () => true);
  const job = await state.jobs.createJob({
    repositoryId: state.repository.repositoryId,
    ownerUserId: "user-1",
    repositoryOwner: "acme",
    repositoryName: "demo",
    repositoryUrl: "https://github.com/acme/demo",
  });
  const claimed = await state.jobs.claimNextJob("worker-1", 60_000);
  assert.equal(claimed?.jobId, job.jobId);
  const claim = indexingJobClaim(claimed!);
  await state.service.delete({
    repositoryId: state.repository.repositoryId,
    ownerUserId: "user-1",
    expectedVersion: state.repository.persistenceVersion ?? 1,
    report: REPORT,
  });
  assert.deepEqual(await state.jobs.listRepositoryJobs(state.repository.repositoryId), []);
  await assert.rejects(state.jobs.updateProgress(job.jobId, 25, "scan", claim));
  await assert.rejects(state.jobs.createJob({
    repositoryId: state.repository.repositoryId,
    ownerUserId: "user-1",
    repositoryOwner: "acme",
    repositoryName: "demo",
    repositoryUrl: "https://github.com/acme/demo",
  }), /repository_deleting_or_deleted/);
});

test("concurrent deletion requests converge on one tombstone", async () => {
  const state = setup(async () => true);
  const input = {
    repositoryId: state.repository.repositoryId,
    ownerUserId: "user-1",
    expectedVersion: state.repository.persistenceVersion ?? 1,
    report: REPORT,
  };
  const results = await Promise.all([state.service.delete(input), state.service.delete(input)]);
  assert.deepEqual(results.map((result) => result.report), [REPORT, REPORT]);
  assert.equal(state.repositories.getRepository(input.repositoryId), null);
  assert.equal(state.repositories.getDeletionTombstone(input.repositoryId)?.deletionState, "deleted");
});

test("memory and Supabase adapters expose equivalent durable tombstones", async () => {
  const responseRow = {
    repository_id: "acme/demo", repository_owner: "acme", repository_name: "demo",
    owner_user_id: "user-1", deletion_state: "deleted", deleted_at: "2026-07-22T00:00:00.000Z",
    deleted_repository_version: 2, cleanup_pending: true, cleanup_attempts: 0,
    cleanup_last_error: null, cleanup_completed_at: null, response_report: REPORT,
  };
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const store = new SupabaseRepositoryStore({
    from: () => { throw new Error("not used"); },
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      calls.push({ name, parameters });
      return { data: [responseRow], error: null };
    },
  } as never);
  const deleted = await store.deleteRepositoryDurably({
    repositoryId: "acme/demo", ownerUserId: "user-1", expectedVersion: 1, responseReport: REPORT,
  });
  assert.equal(deleted.deletionState, "deleted");
  assert.equal(deleted.cleanupPending, true);
  assert.deepEqual(deleted.responseReport, REPORT);
  await store.recordDeletionCleanupResult({ repositoryId: "acme/demo", succeeded: false, error: "busy" });
  assert.deepEqual(calls.map((call) => call.name), [
    "delete_repository_transactionally", "record_repository_deletion_cleanup",
  ]);
  assert.equal(calls[0]?.parameters.input_expected_version, 1);
});

test("filesystem deletion rejects repository identities that could escape storage", async () => {
  await assert.rejects(async () => removeRepositoryCheckout("../escape"));
});

test("migration defines the lock, tombstone, job fence, cascade, and cleanup recovery contract", async () => {
  const sql = (await readFile(new URL(
    "../../supabase/migrations/20260727000000_add_transactional_repository_deletion.sql",
    import.meta.url,
  ), "utf8")).toLowerCase();
  for (const contract of [
    "deletion_state in ('active', 'deleting')",
    "repository_deletion_tombstones",
    "pg_advisory_xact_lock",
    "for update",
    "repository_version = repository_version + 1",
    "delete from public.indexing_jobs",
    "delete from public.repositories",
    "cleanup_pending",
    "record_repository_deletion_cleanup",
    "repositories.deletion_state = 'active'",
    "for update of jobs skip locked",
  ]) assert.ok(sql.includes(contract), `missing deletion contract: ${contract}`);
  const schema = await readFile(new URL(
    "../../supabase/migrations/20260713000000_create_durable_sessions.sql",
    import.meta.url,
  ), "utf8");
  assert.match(schema, /references public\.repositories\(repository_id\) on delete cascade/i);
});
