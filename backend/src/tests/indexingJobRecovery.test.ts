import assert from "node:assert/strict";
import test from "node:test";

import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { recoverIndexingJobsOnStartup } from "../services/indexing/jobs/indexingJobStartupRecovery.js";
import { indexingJobClaim } from "../services/indexing/jobs/indexingJobStore.js";

const TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";

function recoveryFixture(maxAttempts = 3) {
  let time = Date.parse("2026-07-21T00:00:00.000Z");
  const store = new MemoryIndexingJobStore({ now: () => new Date(time) });
  const entries: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    info: (event: string, fields?: Record<string, unknown>) => entries.push({ event, fields }),
    error: (event: string, fields?: Record<string, unknown>) => entries.push({ event, fields }),
  };
  const create = () => store.createJob({
    repositoryId: "acme/recovery",
    ownerUserId: "owner-1",
    repositoryOwner: "acme",
    repositoryName: "recovery",
    repositoryUrl: "https://github.com/acme/recovery",
    maxAttempts,
    createdByRequestId: "request-recovery",
    createdByTraceparent: TRACEPARENT,
  });
  const recover = () => recoverIndexingJobsOnStartup({
    jobStore: store,
    logger,
    leaseDurationMs: 100,
    retryDelayMs: 25,
    now: () => new Date(time),
  });
  return {
    store,
    entries,
    create,
    recover,
    advance: (milliseconds: number) => { time += milliseconds; },
  };
}

test("backend restart discovers unfinished jobs and recovers an abandoned running job", async () => {
  const fixture = recoveryFixture();
  const created = await fixture.create();
  await fixture.store.claimNextJob("crashed-worker", 100);
  await fixture.store.markRunning(created.jobId, "scan");
  fixture.advance(101);

  const report = await fixture.recover();
  const recovered = await fixture.store.getJob(created.jobId);

  assert.deepEqual(report, {
    unfinishedJobs: 1,
    runningJobs: 1,
    recoveredJobs: 1,
    retriedJobs: 1,
    permanentFailures: 0,
  });
  assert.equal(recovered?.status, "queued");
  assert.equal(recovered?.attempt, 2);
  assert.equal(recovered?.progress, 0);
  assert.equal(recovered?.currentStage, "pending");
  assert.equal(recovered?.ownerUserId, "owner-1");
  assert.equal(recovered?.repositoryId, "acme/recovery");
  assert.deepEqual(fixture.entries.map((entry) => entry.event), [
    "indexing_recovery_started",
    "indexing_abandoned_lease_recovered",
    "indexing_job_retry",
    "indexing_recovery_completed",
  ]);
});

test("an active lease is not recovered and heartbeat extends its expiry", async () => {
  const fixture = recoveryFixture();
  const created = await fixture.create();
  const claimed = await fixture.store.claimNextJob("active-worker", 100);
  assert.ok(claimed);
  fixture.advance(50);
  assert.equal(await fixture.store.heartbeatJob(created.jobId, indexingJobClaim(claimed), 100), true);
  const renewed = await fixture.store.getJob(created.jobId);
  assert.notEqual(renewed?.leaseExpiresAt, claimed?.leaseExpiresAt);
  fixture.advance(75);

  assert.equal((await fixture.recover()).recoveredJobs, 0);
  assert.equal((await fixture.store.getJob(created.jobId))?.status, "claimed");
});

test("expired lease rejects renewal and becomes recoverable", async () => {
  const fixture = recoveryFixture();
  const created = await fixture.create();
  const claimed = await fixture.store.claimNextJob("abandoned-worker", 100);
  assert.ok(claimed);
  fixture.advance(100);

  await assert.rejects(
    () => fixture.store.heartbeatJob(created.jobId, indexingJobClaim(claimed), 100),
    { code: "indexing_job_lease_conflict" },
  );
  assert.equal((await fixture.recover()).recoveredJobs, 1);
});

test("atomic claims prevent duplicate workers from processing one job", async () => {
  const fixture = recoveryFixture();
  await fixture.create();
  const [first, second] = await Promise.all([
    fixture.store.claimNextJob("worker-a", 100),
    fixture.store.claimNextJob("worker-b", 100),
  ]);

  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal((first ?? second)?.claimedBy, "worker-a");
});

test("an abandoned worker cannot mutate a job after a replacement claims it", async () => {
  const fixture = recoveryFixture();
  const created = await fixture.create();
  const firstClaimed = await fixture.store.claimNextJob("worker-a", 100);
  assert.ok(firstClaimed);
  const firstClaim = indexingJobClaim(firstClaimed);
  await fixture.store.markRunning(created.jobId, "scan", firstClaim);
  fixture.advance(101);
  await fixture.recover();
  fixture.advance(25);
  const secondClaimed = await fixture.store.claimNextJob("worker-b", 100);
  assert.ok(secondClaimed);
  const secondClaim = indexingJobClaim(secondClaimed);
  await fixture.store.markRunning(created.jobId, "clone", secondClaim);

  await assert.rejects(
    () => fixture.store.updateProgress(created.jobId, 25, "scan", firstClaim),
    { code: "indexing_job_lease_conflict" },
  );
  await assert.rejects(
    () => fixture.store.markSucceeded(created.jobId, firstClaim),
    { code: "indexing_job_lease_conflict" },
  );
  await assert.rejects(
    () => fixture.store.markFailed(created.jobId, {
      code: "stale_worker",
      message: "Stale worker attempted completion.",
      retryable: true,
    }, firstClaim),
    { code: "indexing_job_lease_conflict" },
  );
  assert.equal((await fixture.store.getJob(created.jobId))?.claimedBy, "worker-b");
  assert.equal((await fixture.store.getJob(created.jobId))?.status, "running");
});

test("a recovered retry can later succeed without losing completed history", async () => {
  const fixture = recoveryFixture();
  const created = await fixture.create();
  await fixture.store.claimNextJob("crashed-worker", 100);
  await fixture.store.markRunning(created.jobId, "embed");
  fixture.advance(101);
  await fixture.recover();
  fixture.advance(25);

  const retried = await fixture.store.claimNextJob("replacement-worker", 100);
  assert.equal(retried?.attempt, 2);
  await fixture.store.markRunning(created.jobId, "clone");
  await fixture.store.markSucceeded(created.jobId);

  const completed = await fixture.store.getJob(created.jobId);
  assert.equal(completed?.status, "succeeded");
  assert.equal(completed?.attempt, 2);
  assert.equal((await fixture.recover()).recoveredJobs, 0);
  assert.equal((await fixture.store.listRepositoryJobs("acme/recovery")).length, 1);
});

test("retry exhaustion marks an abandoned job as a permanent terminal failure", async () => {
  const fixture = recoveryFixture(1);
  const created = await fixture.create();
  await fixture.store.claimNextJob("crashed-worker", 100);
  await fixture.store.markRunning(created.jobId, "clone");
  fixture.advance(101);

  const report = await fixture.recover();
  const failed = await fixture.store.getJob(created.jobId);
  assert.equal(report.permanentFailures, 1);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.failure?.retryable, false);
  assert.equal(failed?.failure?.code, "abandoned_lease");
  assert.ok(fixture.entries.some((entry) => entry.event === "indexing_job_permanent_failure"));
});

test("non-retryable failures remain terminal", async () => {
  const fixture = recoveryFixture();
  const created = await fixture.create();
  const claimed = await fixture.store.claimNextJob("worker-a", 100);
  assert.ok(claimed);
  await fixture.store.markRunning(created.jobId, "clone");
  const failure = { code: "invalid_repository", message: "Invalid repository.", retryable: false };
  await fixture.store.markFailed(created.jobId, failure);

  assert.equal(await fixture.store.scheduleRetry(
    created.jobId,
    indexingJobClaim(claimed),
    failure,
    0,
  ), null);
  assert.equal((await fixture.store.getJob(created.jobId))?.status, "failed");
});

test("trace and request correlation survive lease recovery and retry", async () => {
  const fixture = recoveryFixture();
  const created = await fixture.create();
  await fixture.store.claimNextJob("crashed-worker", 100);
  await fixture.store.markRunning(created.jobId, "chunk");
  fixture.advance(101);
  await fixture.recover();

  const recovered = await fixture.store.getJob(created.jobId);
  assert.equal(recovered?.createdByTraceparent, TRACEPARENT);
  assert.equal(recovered?.createdByRequestId, "request-recovery");
  const retryLog = fixture.entries.find((entry) => entry.event === "indexing_job_retry");
  assert.equal(retryLog?.fields?.traceId, "11111111111111111111111111111111");
  assert.equal(retryLog?.fields?.requestId, "request-recovery");
});

test("concurrent startup recovery is safe and recovers an expired lease once", async () => {
  const fixture = recoveryFixture();
  const created = await fixture.create();
  await fixture.store.claimNextJob("crashed-worker", 100);
  await fixture.store.markRunning(created.jobId, "finalize");
  fixture.advance(101);

  const [first, second] = await Promise.all([fixture.recover(), fixture.recover()]);
  assert.equal(first.recoveredJobs + second.recoveredJobs, 1);
  assert.equal((await fixture.store.getJob(created.jobId))?.attempt, 2);
  assert.equal((await fixture.store.getJob(created.jobId))?.recoveryCount, 1);
});
