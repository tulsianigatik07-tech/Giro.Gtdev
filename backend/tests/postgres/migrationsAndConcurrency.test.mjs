import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMigrations,
  createJobSql,
  migrationFiles,
  postgresAvailability,
  psql,
  psqlAsync,
  scalar,
  seedRepositorySql,
  withDisposableDatabase,
} from "./postgresHarness.mjs";

const availability = await postgresAvailability();
const skip = availability.available ? false : availability.reason;
const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);

async function migratedDatabase(callback) {
  return withDisposableDatabase(availability, async ({ url }) => {
    await applyMigrations(url);
    return callback(url);
  });
}

function claimedJob(url, workerId = "worker-1") {
  const value = scalar(url, `
    select job_id || '|' || claim_token
    from public.claim_next_indexing_job('${workerId}', 60000)
  `);
  const [jobId, claimToken] = value.split("|");
  assert.ok(jobId && claimToken, `expected a claimed job, received: ${value}`);
  return { jobId, claimToken, workerId };
}

function markRunning(url, claim) {
  assert.equal(scalar(url, `select count(*) from public.mark_indexing_job_running(
    '${claim.jobId}', '${claim.workerId}', '${claim.claimToken}', 'clone'
  )`), "1");
}

function stageRevision(url, claim, revision) {
  scalar(url, `select already_published from public.begin_repository_snapshot(
    'acme/api', '${revision}', 'main', '${claim.jobId}',
    '${claim.workerId}', '${claim.claimToken}'
  )`);
  psql(url, `select public.save_repository_snapshot_summary(
    'acme/api', '${revision}', '${claim.jobId}', '${claim.workerId}',
    '${claim.claimToken}', '{"repositoryId":"acme/api","repositoryVersion":"${revision}"}'::jsonb
  )`);
  psql(url, `select public.stage_repository_artifacts(
    'acme/api', '${revision}', '${claim.jobId}', '${claim.workerId}', '${claim.claimToken}',
    '{"repositoryId":"acme/api","repositoryVersion":"${revision}","nodes":[],"edges":[]}'::jsonb,
    '{"repositoryId":"acme/api","repositoryVersion":"${revision}"}'::jsonb,
    '{"updatedAt":"2026-07-21T00:00:00.000Z","files":[]}'::jsonb,
    '[]'::jsonb, '[]'::jsonb
  )`);
}

function publishRevision(url, claim, revision, chunkCount = 0, options = {}) {
  return psql(url, `select public.publish_repository_snapshot(
    'acme/api', '${revision}', 'main', '${claim.jobId}', '${claim.workerId}',
    '${options.claimToken ?? claim.claimToken}', ${chunkCount}, 0, 0, 0, 0, true, 'full', 0
  )`, { allowFailure: options.allowFailure });
}

test("full migration chain installs fresh, upgrades from previous, and verifies repeatably", { skip }, async () => {
  const files = await migrationFiles();
  assert.ok(files.length > 1);

  await withDisposableDatabase(availability, async ({ url }) => {
    assert.deepEqual(await applyMigrations(url), files);
    assert.deepEqual(await applyMigrations(url), []);
    assert.equal(Number(scalar(url, "select count(*) from public.giro_schema_migrations")), files.length);
  });

  await withDisposableDatabase(availability, async ({ url }) => {
    const previous = files.slice(0, -1);
    const latest = files.at(-1);
    assert.deepEqual(await applyMigrations(url, { files: previous }), previous);
    assert.equal(scalar(url, "select to_regclass('public.repository_artifacts') is null"), "t");
    assert.deepEqual(await applyMigrations(url, { files: [latest] }), [latest]);
    assert.equal(scalar(url, "select to_regclass('public.repository_artifacts') is not null"), "t");
    assert.deepEqual(await applyMigrations(url), []);
  });
});

test("real schema contains required production objects, grants, RLS, and constraints", { skip }, async () => {
  await migratedDatabase(async (url) => {
    const tables = Number(scalar(url, `select count(*) from information_schema.tables
      where table_schema='public' and table_name in (
        'repositories','indexing_jobs','indexing_workers','sessions','session_messages',
        'repository_chunks','repository_summaries','repository_snapshots','repository_artifacts'
      )`));
    assert.equal(tables, 9);

    for (const [catalog, expected] of [
      ["select count(*) from information_schema.columns where table_schema='public' and table_name='repositories' and column_name in ('repository_version','indexed_revision')", 2],
      ["select count(*) from information_schema.columns where table_schema='public' and table_name='indexing_jobs' and column_name in ('claim_token','lease_expires_at','traceparent','recovery_count')", 4],
      ["select count(*) from pg_indexes where schemaname='public' and indexname in ('repositories_owner_name_idx','indexing_jobs_claim_token_uidx','repository_artifacts_revision_idx')", 3],
      ["select count(*) from pg_constraint where connamespace='public'::regnamespace and conname in ('repositories_version_positive','indexing_jobs_claim_token_consistent','repository_artifacts_snapshot_fk')", 3],
      ["select count(*) from pg_trigger where not tgisinternal and tgname in ('repositories_enforce_version_increment','indexing_jobs_lifecycle_trigger','indexing_jobs_clear_terminal_lease','session_messages_touch_session')", 4],
      ["select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('claim_next_indexing_job','recover_stale_indexing_jobs','publish_repository_snapshot','stage_repository_artifacts','collect_repository_artifacts')", 5],
    ]) assert.equal(Number(scalar(url, catalog)), expected, catalog);

    assert.equal(scalar(url, `select bool_and(relrowsecurity) from pg_class
      where relnamespace='public'::regnamespace and relname in
      ('repositories','indexing_jobs','indexing_workers','repository_snapshots','repository_artifacts')`), "t");
    assert.equal(scalar(url, `select count(*) from pg_policies where schemaname='public'
      and tablename in ('repositories','indexing_jobs','indexing_workers','repository_snapshots','repository_artifacts')`), "0");
    assert.equal(scalar(url, `select
      has_table_privilege('service_role','public.repository_artifacts','select')::int || ':' ||
      has_table_privilege('anon','public.repository_artifacts','select')::int || ':' ||
      has_function_privilege('service_role','public.collect_repository_artifacts(text,integer)','execute')::int || ':' ||
      has_function_privilege('anon','public.collect_repository_artifacts(text,integer)','execute')::int`), "1:0:1:0");

    assert.equal(psql(url, `set role service_role;
      select count(*) from public.repository_artifacts;
      select public.collect_repository_artifacts('missing/repo', 1)`).status, 0);
    assert.notEqual(psql(url, "set role anon; select count(*) from public.repository_artifacts", { allowFailure: true }).status, 0);
    assert.notEqual(psql(url, "set role anon; select count(*) from public.indexing_jobs", { allowFailure: true }).status, 0);
    assert.notEqual(psql(url, "set role authenticated; select public.collect_repository_artifacts('missing/repo', 1)", { allowFailure: true }).status, 0);
    assert.notEqual(psql(url, "set role authenticated; select count(*) from public.claim_next_indexing_job('unauthorized', 60000)", { allowFailure: true }).status, 0);
  });
});

test("repository CAS permits one concurrent writer without losing unrelated state", { skip }, async () => {
  await migratedDatabase(async (url) => {
    psql(url, seedRepositorySql("acme/cas"));
    const update = (timestamp) => `begin;
      with changed as (
        update public.repositories set last_accessed_at='${timestamp}', updated_at=now()
        where repository_id='acme/cas' and repository_version=1 returning 1
      ) select 'won:' || count(*) from changed;
      select pg_sleep(0.25); commit;`;
    const [left, right] = await Promise.all([
      psqlAsync(url, update("2026-07-21T00:00:01Z")),
      psqlAsync(url, update("2026-07-21T00:00:02Z")),
    ]);
    assert.equal(left.status, 0);
    assert.equal(right.status, 0);
    const wins = [left, right].map((result) => Number(result.stdout.match(/won:(\d+)/)?.[1] ?? -1));
    assert.deepEqual(wins.sort(), [0, 1]);
    assert.equal(scalar(url, `select repository_version || ':' || owner_user_id || ':' || status
      from public.repositories where repository_id='acme/cas'`), "2:user-1:connected");
  });
});

test("claims, leases, recovery, and every stale fence are enforced by PostgreSQL", { skip }, async () => {
  await migratedDatabase(async (url) => {
    psql(url, seedRepositorySql("acme/jobs"));
    scalar(url, createJobSql("acme/jobs"));
    const claimSql = "select count(*) from public.claim_next_indexing_job('worker-shared', 60000)";
    const [first, second] = await Promise.all([psqlAsync(url, claimSql), psqlAsync(url, claimSql)]);
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.deepEqual([Number(first.stdout.trim()), Number(second.stdout.trim())].sort(), [0, 1]);
    assert.equal(scalar(url, "select count(distinct claimed_by) from public.indexing_jobs where status='claimed'"), "1");
    const oldToken = scalar(url, "select claim_token from public.indexing_jobs where repository_id='acme/jobs'");
    const jobId = scalar(url, "select job_id from public.indexing_jobs where repository_id='acme/jobs'");
    psql(url, `update public.indexing_jobs set lease_expires_at=now()-interval '1 second' where job_id='${jobId}'`);

    const recoverySql = "select count(*) from public.recover_stale_indexing_jobs(now(), 0, now())";
    const [recoveryA, recoveryB] = await Promise.all([psqlAsync(url, recoverySql), psqlAsync(url, recoverySql)]);
    assert.deepEqual([Number(recoveryA.stdout.trim()), Number(recoveryB.stdout.trim())].sort(), [0, 1]);
    assert.equal(scalar(url, `select status || ':' || attempt || ':' || recovery_count
      from public.indexing_jobs where job_id='${jobId}'`), "queued:2:1");

    const reclaimed = claimedJob(url, "worker-shared");
    assert.notEqual(reclaimed.claimToken, oldToken);
    assert.equal(scalar(url, `select public.heartbeat_indexing_job('${jobId}','worker-shared','${oldToken}',60000)`), "f");
    assert.equal(scalar(url, `select count(*) from public.complete_indexing_job('${jobId}','worker-shared','${oldToken}')`), "0");
    assert.equal(scalar(url, `select count(*) from public.fail_indexing_job(
      '${jobId}','worker-shared','${oldToken}','stale','stale failure',false)`), "0");
    assert.equal(scalar(url, `select count(*) from public.mark_indexing_job_running(
      '${jobId}','worker-shared','${oldToken}','clone')`), "0");
    assert.equal(scalar(url, "select count(*) from public.indexing_jobs where status='succeeded'"), "0");
  });
});

test("artifact publication is atomic, revision-safe, fenced, and GC-safe concurrently", { skip }, async () => {
  await migratedDatabase(async (url) => {
    psql(url, seedRepositorySql("acme/api"));
    scalar(url, createJobSql("acme/api"));
    const first = claimedJob(url, "publisher-1");
    markRunning(url, first);
    stageRevision(url, first, REVISION_A);
    assert.equal(publishRevision(url, first, REVISION_A).status, 0);
    assert.equal(scalar(url, "select indexed_revision from public.repositories where repository_id='acme/api'"), REVISION_A);

    scalar(url, createJobSql("acme/api"));
    const second = claimedJob(url, "publisher-2");
    markRunning(url, second);
    stageRevision(url, second, REVISION_B);
    const failed = publishRevision(url, second, REVISION_B, 1, { allowFailure: true });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /chunk count does not match/i);
    assert.equal(scalar(url, "select indexed_revision from public.repositories where repository_id='acme/api'"), REVISION_A);
    assert.equal(scalar(url, `select status from public.repository_snapshots
      where repository_id='acme/api' and revision='${REVISION_B}'`), "building");
    assert.equal(scalar(url, `select status from public.indexing_jobs where job_id='${second.jobId}'`), "running");
    assert.equal(scalar(url, `select count(*) from public.get_repository_artifacts('acme/api','${REVISION_A}')`), "1");

    const stale = publishRevision(url, second, REVISION_B, 0, { allowFailure: true, claimToken: "stale-token" });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /indexing_job_lease_conflict/i);
    assert.equal(publishRevision(url, second, REVISION_B).status, 0);
    assert.equal(scalar(url, "select indexed_revision from public.repositories where repository_id='acme/api'"), REVISION_B);
    assert.equal(scalar(url, `select count(*) from public.get_repository_artifacts('acme/api','${REVISION_A}')`), "1");
    assert.equal(scalar(url, `select count(*) from public.get_current_repository_artifacts('acme/api')`), "1");

    const cleanup = "select public.collect_repository_artifacts('acme/api',1)";
    const [cleanupA, cleanupB] = await Promise.all([psqlAsync(url, cleanup), psqlAsync(url, cleanup)]);
    assert.equal(cleanupA.status, 0);
    assert.equal(cleanupB.status, 0);
    assert.equal(Number(cleanupA.stdout.trim()) + Number(cleanupB.stdout.trim()), 1);
    assert.equal(scalar(url, `select count(*) from public.repository_snapshots
      where repository_id='acme/api' and revision='${REVISION_B}' and status='published'`), "1");
    assert.equal(scalar(url, "select count(*) from public.indexing_jobs where status='succeeded'"), "2");
    assert.equal(scalar(url, "select count(*)-count(distinct job_id) from public.indexing_jobs where status='succeeded'"), "0");
  });
});
