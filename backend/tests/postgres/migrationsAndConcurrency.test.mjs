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
const REVISION_C = "c".repeat(40);
const WORKER_CONTRACT_MIGRATION = "20260802000000_add_worker_functional_readiness.sql";
const EMBEDDING_INDEX_MIGRATION = "20260803000000_add_embedding_index_versions.sql";
const REPOSITORY_GRAPH_MIGRATION = "20260805000000_add_durable_repository_graphs.sql";

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

function stageEmbeddingIndex(url, claim, revision) {
  const embeddingVersion = `test-${revision}`;
  assert.equal(scalar(url, `select already_published from public.begin_embedding_index_version(
    'acme/api', '${revision}', 'mock', 'deterministic-test', 1536,
    '${embeddingVersion}', 'test-v1', '${claim.jobId}', '${claim.workerId}',
    '${claim.claimToken}'
  )`), "f");
  assert.equal(scalar(url, `select is_valid from public.validate_embedding_index_version(
    'acme/api', '${revision}', '${embeddingVersion}', 0, '${claim.jobId}',
    '${claim.workerId}', '${claim.claimToken}'
  )`), "t");
  return embeddingVersion;
}

function stageRepositoryGraph(url, claim, revision) {
  const graphVersion = `graph-${revision}`;
  const alreadyPublished = scalar(url, `select already_published from public.begin_repository_graph_version(
    'acme/api', '${revision}', '${graphVersion}', 'typescript-compiler-v1',
    '${claim.jobId}', '${claim.workerId}', '${claim.claimToken}'
  )`);
  if (alreadyPublished === "t") return graphVersion;
  psql(url, `select public.stage_repository_graph_version(
    'acme/api', '${revision}', '${graphVersion}', '${claim.jobId}',
    '${claim.workerId}', '${claim.claimToken}',
    '[{"nodeId":"node-${revision}","kind":"repository","name":"acme/api",
       "qualifiedName":"acme/api","file":"","language":"unknown","line":1,
       "endLine":1,"column":1,"endColumn":1,"exported":false,
       "defaultExport":false,"metadata":{}}]'::jsonb,
    '[]'::jsonb,
    '{"parsedFileCount":0,"parserFailureCount":0,"unresolvedImportCount":0,
      "importCount":0,"unresolvedFileRatio":0,"parserFailureRatio":0,
      "orphanSymbolCount":0,"duplicateNodeIdCount":0,"duplicateEdgeIdCount":0,
      "missingEndpointCount":0,"impossibleSelfEdgeCount":0,"graphBytes":1,
      "durationMs":1,"failures":[]}'::jsonb
  )`);
  assert.equal(scalar(url, `select valid from public.validate_repository_graph_version(
    'acme/api', '${revision}', '${graphVersion}', '${claim.jobId}',
    '${claim.workerId}', '${claim.claimToken}', 10, 10, 10000, 10000, 1, 1
  )`), "t");
  return graphVersion;
}

function publishRevision(url, claim, revision, chunkCount = 0, options = {}) {
  const embeddingVersion = options.embeddingVersion ?? `test-${revision}`;
  stageRepositoryGraph(url, claim, revision);
  return psql(url, `select public.publish_repository_snapshot(
    'acme/api', '${revision}', 'main', '${claim.jobId}', '${claim.workerId}',
    '${options.claimToken ?? claim.claimToken}', ${chunkCount}, 0, 0, 1, 0, true,
    '${embeddingVersion}', 'full', 0, 'user-1', 0, 10, 1000000
  )`, { allowFailure: options.allowFailure });
}

test("full migration chain installs fresh, upgrades from previous, and verifies repeatably", { skip }, async () => {
  const files = await migrationFiles();
  assert.ok(files.length > 1);
  const workerMigrationIndex = files.indexOf(WORKER_CONTRACT_MIGRATION);
  assert.ok(workerMigrationIndex > 0, `${WORKER_CONTRACT_MIGRATION} must have a predecessor`);
  assert.ok(files.includes(EMBEDDING_INDEX_MIGRATION), `${EMBEDDING_INDEX_MIGRATION} must be installed`);
  assert.ok(files.includes(REPOSITORY_GRAPH_MIGRATION), `${REPOSITORY_GRAPH_MIGRATION} must be installed`);

  await withDisposableDatabase(availability, async ({ url }) => {
    assert.deepEqual(await applyMigrations(url), files);
    assert.deepEqual(await applyMigrations(url), []);
    assert.equal(Number(scalar(url, "select count(*) from public.giro_schema_migrations")), files.length);
    assert.equal(scalar(url, "select max(version) from public.giro_schema_migrations"), files.at(-1));
  });

  await withDisposableDatabase(availability, async ({ url }) => {
    const beforeWorkerContract = files.slice(0, workerMigrationIndex);
    const laterMigrations = files.slice(workerMigrationIndex + 1);
    assert.deepEqual(
      await applyMigrations(url, { files: beforeWorkerContract }),
      beforeWorkerContract,
    );
    assert.equal(scalar(url, "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='indexing_workers' and column_name='functional_ready')"), "f");
    assert.deepEqual(
      await applyMigrations(url, { files: [WORKER_CONTRACT_MIGRATION] }),
      [WORKER_CONTRACT_MIGRATION],
    );
    assert.equal(scalar(url, "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='indexing_workers' and column_name='functional_ready')"), "t");
    assert.equal(scalar(url, "select public.validate_indexing_worker_contract()->>'contract_valid'"), "true");
    assert.deepEqual(await applyMigrations(url, { files: laterMigrations }), laterMigrations);
    assert.equal(scalar(url, "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='indexing_workers' and column_name='functional_ready')"), "t");
    assert.equal(scalar(url, "select public.validate_indexing_worker_contract()->>'contract_valid'"), "true");
    assert.deepEqual(await applyMigrations(url), []);
  });
});

test("real schema contains required production objects, grants, RLS, and constraints", { skip }, async () => {
  await migratedDatabase(async (url) => {
    const files = await migrationFiles();
    const tables = Number(scalar(url, `select count(*) from information_schema.tables
      where table_schema='public' and table_name in (
        'repositories','indexing_jobs','indexing_workers','sessions','session_messages',
        'repository_chunks','repository_summaries','repository_snapshots','repository_artifacts',
        'embedding_index_versions','embedding_index_validations','embedding_index_publications',
        'repository_graph_versions','repository_graph_nodes','repository_graph_edges',
        'repository_graph_diagnostics','repository_graph_publications'
      )`));
    assert.equal(tables, 17);

    for (const [catalog, expected] of [
      ["select count(*) from information_schema.columns where table_schema='public' and table_name='repositories' and column_name in ('repository_version','indexed_revision')", 2],
      ["select count(*) from information_schema.columns where table_schema='public' and table_name='indexing_jobs' and column_name in ('claim_token','lease_expires_at','traceparent','recovery_count')", 4],
      ["select count(*) from information_schema.columns where table_schema='public' and table_name='repository_chunks' and column_name in ('embedding_version','chunk_id','chunk_hash')", 3],
      [`select count(*) from pg_indexes where schemaname='public' and indexname in (
        'repositories_owner_name_idx','indexing_jobs_claim_token_uidx','repository_artifacts_revision_idx',
        'embedding_index_versions_repository_status_idx','embedding_index_versions_cleanup_idx',
        'embedding_index_publications_revision_idx','repository_chunks_embedding_chunk_uidx',
        'repository_chunks_embedding_position_uidx','repository_chunks_embedding_version_idx',
        'repository_chunks_cleanup_idx'
      )`, 10],
      [`select count(*) from pg_indexes where schemaname='public' and indexname in (
        'repository_graph_versions_single_pending_idx','repository_graph_versions_revision_parser_idx',
        'repository_graph_versions_retention_idx','repository_graph_nodes_symbol_idx',
        'repository_graph_nodes_file_location_idx','repository_graph_nodes_qualified_name_idx',
        'repository_graph_edges_outbound_idx','repository_graph_edges_inbound_idx',
        'repository_graph_edges_kind_idx','repository_graph_publications_revision_idx'
      )`, 10],
      [`select count(*) from pg_constraint where connamespace='public'::regnamespace and conname in (
        'repositories_version_positive','indexing_jobs_claim_token_consistent','repository_artifacts_snapshot_fk',
        'embedding_index_versions_status_valid','embedding_index_versions_publication_timestamp',
        'embedding_index_validations_result_consistent','embedding_index_publications_version_identity_fkey',
        'repository_chunks_embedding_version_identity_fkey','repository_chunks_chunk_metadata_present'
      )`, 9],
      [`select count(*) from pg_constraint where connamespace='public'::regnamespace and conname in (
        'repository_graph_versions_status_valid','repository_graph_versions_revision_fkey',
        'repository_graph_nodes_version_identity_fkey','repository_graph_edges_version_identity_fkey',
        'repository_graph_publications_version_identity_fkey'
      )`, 5],
      [`select count(*) from pg_trigger where not tgisinternal and tgname in (
        'repositories_enforce_version_increment','indexing_jobs_lifecycle_trigger',
        'indexing_jobs_clear_terminal_lease','session_messages_touch_session',
        'embedding_index_versions_immutable_identity_trigger','repository_chunks_immutable_version_trigger',
        'repository_graph_versions_immutable_identity_trigger',
        'repository_graph_nodes_mutability_trigger','repository_graph_edges_mutability_trigger'
      )`, 9],
      [`select count(*) from unnest(array[
        'public.claim_next_indexing_job(text,integer)',
        'public.recover_stale_indexing_jobs(timestamp with time zone,integer,timestamp with time zone)',
        'public.create_indexing_job(text,text,text,text,text,text,integer,text,text,integer)',
        'public.publish_repository_snapshot(text,text,text,text,text,text,integer,integer,integer,integer,integer,boolean,text,text,integer,text,bigint,integer,bigint)',
        'public.stage_repository_artifacts(text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,bigint)',
        'public.collect_repository_artifacts(text,integer)',
        'public.begin_embedding_index_version(text,text,text,text,integer,text,text,text,text,text)',
        'public.validate_embedding_index_version(text,text,text,integer,text,text,text)',
        'public.verify_embedding_index_contract()',
        'public.begin_repository_graph_version(text,text,text,text,text,text,text)',
        'public.stage_repository_graph_version(text,text,text,text,text,text,jsonb,jsonb,jsonb)',
        'public.validate_repository_graph_version(text,text,text,text,text,text,integer,integer,integer,bigint,double precision,double precision)',
        'public.discard_repository_graph_version(text,text,text,text,text,text,jsonb)',
        'public.get_published_repository_graph(text,text)',
        'public.collect_repository_graph_versions(text,integer)',
        'public.recover_repository_graph_versions()',
        'public.verify_repository_graph_contract()'
      ]) signature where to_regprocedure(signature) is not null`, 17],
    ]) assert.equal(Number(scalar(url, catalog)), expected, catalog);

    assert.equal(scalar(url, `select bool_and(relrowsecurity) from pg_class
      where relnamespace='public'::regnamespace and relname in
      ('repositories','indexing_jobs','indexing_workers','repository_snapshots','repository_artifacts',
       'embedding_index_versions','embedding_index_validations','embedding_index_publications',
       'repository_graph_versions','repository_graph_nodes','repository_graph_edges',
       'repository_graph_diagnostics','repository_graph_publications')`), "t");
    assert.equal(scalar(url, `select count(*) from pg_policies where schemaname='public'
      and tablename in ('repositories','indexing_jobs','indexing_workers','repository_snapshots',
        'repository_artifacts','embedding_index_versions','embedding_index_validations',
        'embedding_index_publications','repository_graph_versions','repository_graph_nodes',
        'repository_graph_edges','repository_graph_diagnostics','repository_graph_publications')`), "0");
    assert.equal(scalar(url, `select
      has_table_privilege('service_role','public.repository_artifacts','select')::int || ':' ||
      has_table_privilege('anon','public.repository_artifacts','select')::int || ':' ||
      has_table_privilege('service_role','public.embedding_index_versions','select')::int || ':' ||
      has_table_privilege('anon','public.embedding_index_versions','select')::int || ':' ||
      has_function_privilege('service_role','public.collect_repository_artifacts(text,integer)','execute')::int || ':' ||
      has_function_privilege('anon','public.collect_repository_artifacts(text,integer)','execute')::int || ':' ||
      has_function_privilege(
        'service_role',
        'public.publish_repository_snapshot(text,text,text,text,text,text,integer,integer,integer,integer,integer,boolean,text,text,integer,text,bigint,integer,bigint)',
        'execute'
      )::int || ':' ||
      has_function_privilege(
        'service_role',
        'public.publish_repository_snapshot(text,text,text,text,text,text,integer,integer,integer,integer,integer,boolean,text,integer,text,bigint,integer,bigint)',
        'execute'
      )::int`), "1:0:1:0:1:0:1:0");
    const workerContract = JSON.parse(scalar(url, "select public.validate_indexing_worker_contract()"));
    assert.equal(workerContract.contract_valid, true);
    assert.equal(workerContract.migration_version, WORKER_CONTRACT_MIGRATION);
    assert.equal(workerContract.required_contract_migration, WORKER_CONTRACT_MIGRATION);
    assert.equal(
      scalar(url, "select max(version) from public.giro_schema_migrations"),
      files.at(-1),
    );
    assert.equal(scalar(url, "select valid from public.verify_embedding_index_contract()"), "t");
    assert.equal(scalar(url, "select valid from public.verify_repository_graph_contract()"), "t");

    assert.equal(psql(url, `set role service_role;
      select count(*) from public.repository_artifacts;
      select count(*) from public.embedding_index_versions;
      select public.collect_repository_artifacts('missing/repo', 1);
      select public.validate_indexing_worker_contract();
      select public.verify_embedding_index_contract();
      select public.verify_repository_graph_contract()`).status, 0);
    assert.notEqual(psql(url, "set role anon; select count(*) from public.repository_artifacts", { allowFailure: true }).status, 0);
    assert.notEqual(psql(url, "set role anon; select count(*) from public.embedding_index_versions", { allowFailure: true }).status, 0);
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
    stageEmbeddingIndex(url, first, REVISION_A);
    assert.equal(publishRevision(url, first, REVISION_A).status, 0);
    assert.equal(scalar(url, "select indexed_revision from public.repositories where repository_id='acme/api'"), REVISION_A);
    assert.equal(scalar(url, "select repository_revision from public.repository_graph_publications where repository_id='acme/api'"), REVISION_A);

    scalar(url, createJobSql("acme/api"));
    const second = claimedJob(url, "publisher-2");
    markRunning(url, second);
    stageRevision(url, second, REVISION_B);
    stageEmbeddingIndex(url, second, REVISION_B);
    const failed = publishRevision(url, second, REVISION_B, 1, { allowFailure: true });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /validated embedding index is required/i);
    assert.equal(scalar(url, "select indexed_revision from public.repositories where repository_id='acme/api'"), REVISION_A);
    assert.equal(scalar(url, "select repository_revision from public.repository_graph_publications where repository_id='acme/api'"), REVISION_A);
    assert.equal(scalar(url, `select status from public.repository_snapshots
      where repository_id='acme/api' and revision='${REVISION_B}'`), "building");
    assert.equal(scalar(url, `select status from public.indexing_jobs where job_id='${second.jobId}'`), "running");
    assert.equal(scalar(url, `select count(*) from public.get_repository_artifacts('acme/api','${REVISION_A}')`), "1");

    const stale = publishRevision(url, second, REVISION_B, 0, { allowFailure: true, claimToken: "stale-token" });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /indexing_job_lease_conflict/i);
    assert.equal(publishRevision(url, second, REVISION_B).status, 0);
    assert.equal(scalar(url, "select indexed_revision from public.repositories where repository_id='acme/api'"), REVISION_B);
    assert.equal(scalar(url, "select repository_revision from public.repository_graph_publications where repository_id='acme/api'"), REVISION_B);
    assert.equal(scalar(url, `select count(*) from public.get_repository_artifacts('acme/api','${REVISION_A}')`), "1");
    assert.equal(scalar(url, `select count(*) from public.get_current_repository_artifacts('acme/api')`), "1");

    scalar(url, createJobSql("acme/api"));
    const third = claimedJob(url, "publisher-3");
    markRunning(url, third);
    stageRevision(url, third, REVISION_C);
    stageEmbeddingIndex(url, third, REVISION_C);
    assert.equal(publishRevision(url, third, REVISION_C).status, 0);
    assert.equal(scalar(url, "select indexed_revision from public.repositories where repository_id='acme/api'"), REVISION_C);
    assert.equal(scalar(url, "select repository_revision from public.repository_graph_publications where repository_id='acme/api'"), REVISION_C);

    const cleanup = "select public.collect_repository_artifacts('acme/api',1)";
    const [cleanupA, cleanupB] = await Promise.all([psqlAsync(url, cleanup), psqlAsync(url, cleanup)]);
    assert.equal(cleanupA.status, 0);
    assert.equal(cleanupB.status, 0);
    assert.equal(Number(cleanupA.stdout.trim()) + Number(cleanupB.stdout.trim()), 1);
    assert.equal(scalar(url, `select count(*) from public.get_repository_artifacts('acme/api','${REVISION_A}')`), "0");
    assert.equal(scalar(url, `select count(*) from public.get_repository_artifacts('acme/api','${REVISION_B}')`), "1");
    assert.equal(scalar(url, `select count(*) from public.repository_snapshots
      where repository_id='acme/api' and revision='${REVISION_C}' and status='published'`), "1");
    assert.equal(scalar(url, "select count(*) from public.indexing_jobs where status='succeeded'"), "3");
    assert.equal(scalar(url, "select count(*)-count(distinct job_id) from public.indexing_jobs where status='succeeded'"), "0");
    const graphCleanup = "select public.collect_repository_graph_versions('acme/api',1)";
    const [graphCleanupA, graphCleanupB] = await Promise.all([
      psqlAsync(url, graphCleanup), psqlAsync(url, graphCleanup),
    ]);
    assert.equal(graphCleanupA.status, 0);
    assert.equal(graphCleanupB.status, 0);
    assert.equal(Number(graphCleanupA.stdout.trim()) + Number(graphCleanupB.stdout.trim()), 1);
    assert.equal(scalar(url, `select count(*) from public.repository_graph_versions
      where repository_id='acme/api' and status='published'`), "1");
    assert.equal(scalar(url, "select valid from public.verify_repository_graph_contract()"), "t");
    psql(url, "delete from public.repositories where repository_id='acme/api'");
    assert.equal(scalar(url, `select
      (select count(*) from public.repository_graph_versions) +
      (select count(*) from public.repository_graph_nodes) +
      (select count(*) from public.repository_graph_edges) +
      (select count(*) from public.repository_graph_publications)`), "0");
  });
});
