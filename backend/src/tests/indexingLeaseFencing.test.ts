import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import {
  INDEXING_JOB_LEASE_CONFLICT,
  indexingJobClaim,
  type CreateIndexingJobInput,
  type IndexingJobClaim,
  type IndexingJobFailure,
} from "../services/indexing/jobs/indexingJobStore.js";
import { SupabaseIndexingJobStore } from "../services/indexing/jobs/supabaseIndexingJobStore.js";
import { SupabaseRepositorySnapshotStore } from "../services/indexing/snapshots/repositorySnapshotStore.js";
import { IndexingProgressPublisher } from "../services/indexing/events/indexingProgressPublisher.js";

const INPUT: CreateIndexingJobInput = {
  repositoryId: "acme/fenced",
  ownerUserId: "owner-1",
  repositoryOwner: "acme",
  repositoryName: "fenced",
  repositoryUrl: "https://github.com/acme/fenced",
  createdByTraceparent: "00-11111111111111111111111111111111-2222222222222222-01",
};
const FAILURE: IndexingJobFailure = {
  code: "indexing_failed",
  message: "Repository indexing failed.",
  retryable: true,
};

function fixture() {
  let now = Date.parse("2026-07-21T00:00:00.000Z");
  let tokenSequence = 0;
  const store = new MemoryIndexingJobStore({
    now: () => new Date(now),
    generateClaimToken: () => `opaque-claim-${++tokenSequence}`,
  });
  return {
    store,
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

async function claimedRunning() {
  const value = fixture();
  const created = await value.store.createJob(INPUT);
  const claimed = await value.store.claimNextJob("worker-1", 100);
  assert.ok(claimed);
  const claim = indexingJobClaim(claimed);
  await value.store.markRunning(created.jobId, "clone", claim);
  return { ...value, created, claimed, claim };
}

async function rejectsConflict(
  operation: () => Promise<unknown>,
  forbiddenValues: readonly string[] = [],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, INDEXING_JOB_LEASE_CONFLICT);
    const publicError = JSON.stringify({
      code: (error as { code?: unknown }).code,
      message: (error as { message?: unknown }).message,
      name: (error as { name?: unknown }).name,
    });
    for (const forbiddenValue of forbiddenValues) {
      assert.equal(publicError.includes(forbiddenValue), false);
    }
    return true;
  });
}

test("every claim, recovered claim, and retry claim receives a new opaque token", async () => {
  const value = fixture();
  const created = await value.store.createJob(INPUT);
  const first = await value.store.claimNextJob("worker-1", 100);
  assert.ok(first?.claimToken);
  const firstClaim = indexingJobClaim(first);
  await value.store.markRunning(created.jobId, "scan", firstClaim);
  value.advance(101);
  await value.store.recoverStaleJobs({
    staleBefore: new Date(Date.parse(first.leaseExpiresAt!) - 1).toISOString(),
    leaseExpiresBefore: new Date(Date.parse(first.leaseExpiresAt!)).toISOString(),
    retryDelayMs: 0,
  });
  const recovered = await value.store.claimNextJob("worker-2", 100);
  assert.ok(recovered?.claimToken);
  assert.notEqual(recovered.claimToken, first.claimToken);
  const recoveredClaim = indexingJobClaim(recovered);
  await value.store.markRunning(created.jobId, "clone", recoveredClaim);
  await value.store.markFailed(created.jobId, FAILURE, recoveredClaim);
  await value.store.scheduleRetry(created.jobId, recoveredClaim, FAILURE, 0);
  const retry = await value.store.claimNextJob("worker-2", 100);
  assert.ok(retry?.claimToken);
  assert.notEqual(retry.claimToken, recovered.claimToken);
  assert.equal(retry.createdByTraceparent, INPUT.createdByTraceparent);
});

test("current claim can run, report progress, heartbeat, complete, and fail", async () => {
  const successful = await claimedRunning();
  assert.equal(await successful.store.heartbeatJob(
    successful.created.jobId,
    successful.claim,
    100,
  ), true);
  assert.equal((await successful.store.updateProgress(
    successful.created.jobId,
    25,
    "scan",
    successful.claim,
  ))?.progress, 25);
  assert.equal((await successful.store.markSucceeded(
    successful.created.jobId,
    successful.claim,
  ))?.status, "succeeded");

  const failing = await claimedRunning();
  assert.equal((await failing.store.markFailed(
    failing.created.jobId,
    FAILURE,
    failing.claim,
  ))?.status, "failed");
});

test("same worker ID with an old token is rejected for every worker mutation", async () => {
  const value = await claimedRunning();
  const stale: IndexingJobClaim = {
    workerId: value.claim.workerId,
    claimToken: "replaced-token",
  };
  await rejectsConflict(
    () => value.store.heartbeatJob(value.created.jobId, stale, 100),
    [stale.claimToken, value.claim.claimToken],
  );
  await rejectsConflict(() => value.store.updateProgress(value.created.jobId, 25, "scan", stale));
  await rejectsConflict(() => value.store.markSucceeded(value.created.jobId, stale));
  await rejectsConflict(() => value.store.markFailed(value.created.jobId, FAILURE, stale));
});

test("lease expiry immediately invalidates heartbeat, progress, completion, and failure", async () => {
  const value = await claimedRunning();
  value.advance(100);
  await rejectsConflict(() => value.store.heartbeatJob(value.created.jobId, value.claim, 100));
  await rejectsConflict(() => value.store.updateProgress(value.created.jobId, 25, "scan", value.claim));
  await rejectsConflict(() => value.store.markSucceeded(value.created.jobId, value.claim));
  await rejectsConflict(() => value.store.markFailed(value.created.jobId, FAILURE, value.claim));
});

test("concurrent recovery and reclaim allows only one new owner", async () => {
  const value = await claimedRunning();
  value.advance(101);
  const recovery = {
    staleBefore: "2026-07-21T00:00:00.100Z",
    leaseExpiresBefore: "2026-07-21T00:00:00.101Z",
    retryDelayMs: 0,
  };
  await Promise.all([
    value.store.recoverStaleJobs(recovery),
    value.store.recoverStaleJobs(recovery),
  ]);
  const claims = await Promise.all([
    value.store.claimNextJob("replacement-1", 100),
    value.store.claimNextJob("replacement-2", 100),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.notEqual(claims.find(Boolean)?.claimToken, value.claim.claimToken);
});

test("Supabase worker mutations consistently send both fencing coordinates", async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const client = {
    from: () => { throw new Error("unexpected table query"); },
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      calls.push({ name, parameters });
      return { data: name === "heartbeat_indexing_job" ? false : [], error: null };
    },
  };
  const store = new SupabaseIndexingJobStore({ client });
  const claim = { workerId: "worker-1", claimToken: "opaque-supabase-claim" };
  await rejectsConflict(() => store.heartbeatJob("job-1", claim));
  await rejectsConflict(() => store.markRunning("job-1", "clone", claim));
  await rejectsConflict(() => store.markSucceeded("job-1", claim));
  await rejectsConflict(() => store.markFailed("job-1", FAILURE, claim));
  await rejectsConflict(() => store.cancelJob("job-1", claim));
  for (const call of calls) {
    assert.equal(call.parameters.input_worker_id, claim.workerId);
    assert.equal(call.parameters.input_claim_token, claim.claimToken);
  }
});

test("claim tokens never appear in structured indexing logs", async () => {
  const value = fixture();
  await value.store.createJob(INPUT);
  const claimed = await value.store.claimNextJob("worker-1", 100);
  assert.ok(claimed?.claimToken);
  const entries: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const publisher = new IndexingProgressPublisher({
    jobStore: value.store,
    logger: { info: (event, fields) => entries.push({ event, fields }) },
    metrics: {
      incrementActiveSseClients() {},
      decrementActiveSseClients() {},
      incrementPublishedProgressEvents() {},
      incrementSseStreams() {},
    },
  });
  await publisher.publish(claimed);
  assert.equal(JSON.stringify(entries).includes(claimed.claimToken), false);
  assert.equal(JSON.stringify(entries).includes("claimToken"), false);
});

test("snapshot staging, summary, publication, and discard carry the exact token", async () => {
  const calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  const client = {
    from: () => ({ upsert: async () => ({ error: null }) }),
    rpc: async (name: string, parameters: Record<string, unknown>) => {
      calls.push({ name, parameters });
      return {
        data: name === "begin_repository_snapshot"
          ? [{ already_published: false }]
          : null,
        error: name === "publish_repository_snapshot"
          ? { code: "40001", message: "indexing_job_lease_conflict" }
          : null,
      };
    },
  };
  const store = new SupabaseRepositorySnapshotStore(client);
  const identity = {
    repositoryId: INPUT.repositoryId,
    revision: "a".repeat(40),
    branch: "main",
    jobId: "indexing-job-1",
    workerId: "worker-1",
    claimToken: "snapshot-fence-token",
  };
  await store.begin(identity);
  await store.saveSummary(identity, { repositoryId: INPUT.repositoryId } as never);
  await rejectsConflict(() => store.publish({
    ...identity,
    embeddingVersion: "embedding-index-test",
    counts: {
      chunkCount: 1, fileCount: 1, symbolCount: 1,
      graphNodeCount: 1, graphEdgeCount: 0, summaryAvailable: true,
    },
  }));
  await store.discard(identity);
  for (const call of calls) {
    assert.equal(call.parameters.input_claim_token, identity.claimToken);
  }
});

test("migration stores claim tokens and fences every atomic predicate", async () => {
  const sql = (await readFile(new URL(
    "../../supabase/migrations/20260724000000_add_indexing_lease_fencing.sql",
    import.meta.url,
  ), "utf8")).toLowerCase();
  for (const contract of [
    "add column if not exists claim_token",
    "claim_token = gen_random_uuid()::text",
    "for update skip locked",
    "input_claim_token",
    "jobs.claim_token = input_claim_token",
    "lease_expires_at > now()",
    "indexing_job_lease_conflict",
    "save_repository_snapshot_summary",
    "publish_repository_snapshot",
    "status = 'succeeded'",
  ]) assert.ok(sql.includes(contract), `missing lease-fencing contract: ${contract}`);
  assert.doesNotMatch(sql, /grant execute on function public\.heartbeat_indexing_job\(text, text, integer\)/);
});
