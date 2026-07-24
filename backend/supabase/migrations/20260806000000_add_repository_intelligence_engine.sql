create table if not exists public.repository_intelligence_versions (
  intelligence_version text primary key,
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  repository_revision text not null,
  graph_version text not null references public.repository_graph_versions(graph_version) on delete cascade,
  embedding_version text not null references public.embedding_index_versions(embedding_version) on delete cascade,
  parser_version text not null,
  analysis_version text not null,
  schema_version text not null default 'repository-intelligence-schema-v1',
  job_id text references public.indexing_jobs(job_id) on delete set null,
  status text not null,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint repository_intelligence_versions_identity_unique
    unique (intelligence_version, repository_id, repository_revision),
  constraint repository_intelligence_versions_revision_fkey
    foreign key (repository_id, repository_revision)
    references public.repository_snapshots(repository_id, revision) on delete cascade,
  constraint repository_intelligence_versions_configuration_unique
    unique (repository_id, repository_revision, graph_version, embedding_version, parser_version, analysis_version),
  constraint repository_intelligence_versions_status_valid
    check (status in ('building', 'validating', 'published', 'failed', 'superseded')),
  constraint repository_intelligence_versions_metadata_present check (
    btrim(intelligence_version) <> '' and btrim(repository_revision) <> ''
    and btrim(graph_version) <> '' and btrim(embedding_version) <> ''
    and btrim(parser_version) <> '' and btrim(analysis_version) <> ''
  ),
  constraint repository_intelligence_versions_publication_timestamp check (
    status <> 'published' or published_at is not null
  )
);

create table if not exists public.repository_intelligence_snapshots (
  intelligence_version text primary key
    references public.repository_intelligence_versions(intelligence_version) on delete cascade,
  snapshot jsonb not null,
  publication_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint repository_intelligence_snapshot_object check (jsonb_typeof(snapshot) = 'object'),
  constraint repository_intelligence_publication_metadata_object
    check (jsonb_typeof(publication_metadata) = 'object')
);

create table if not exists public.repository_intelligence_subsystems (
  intelligence_version text not null
    references public.repository_intelligence_versions(intelligence_version) on delete cascade,
  subsystem_id text not null,
  summary jsonb not null,
  created_at timestamptz not null default now(),
  primary key (intelligence_version, subsystem_id),
  constraint repository_intelligence_subsystem_id_present check (btrim(subsystem_id) <> ''),
  constraint repository_intelligence_subsystem_summary_object check (jsonb_typeof(summary) = 'object')
);

create table if not exists public.repository_intelligence_metrics (
  intelligence_version text primary key
    references public.repository_intelligence_versions(intelligence_version) on delete cascade,
  files_analyzed integer not null,
  symbols_analyzed integer not null,
  dependency_edges_analyzed integer not null,
  generated_subsystems integer not null,
  quality_findings integer not null,
  hotspots integer not null,
  analysis_duration_ms double precision not null default 0,
  created_at timestamptz not null default now(),
  constraint repository_intelligence_metric_counts_nonnegative check (
    files_analyzed >= 0 and symbols_analyzed >= 0 and dependency_edges_analyzed >= 0
    and generated_subsystems >= 0 and quality_findings >= 0 and hotspots >= 0
    and analysis_duration_ms >= 0
  )
);

create table if not exists public.repository_intelligence_diagnostics (
  diagnostic_id bigint generated always as identity primary key,
  intelligence_version text not null
    references public.repository_intelligence_versions(intelligence_version) on delete cascade,
  severity text not null default 'error',
  code text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint repository_intelligence_diagnostic_severity_valid
    check (severity in ('info', 'warning', 'error')),
  constraint repository_intelligence_diagnostic_present
    check (btrim(code) <> '' and btrim(message) <> ''),
  constraint repository_intelligence_diagnostic_details_object
    check (jsonb_typeof(details) = 'object')
);

create table if not exists public.repository_intelligence_publications (
  repository_id text primary key references public.repositories(repository_id) on delete cascade,
  repository_revision text not null,
  intelligence_version text not null unique,
  graph_version text not null,
  embedding_version text not null,
  published_at timestamptz not null,
  rollback_intelligence_version text,
  constraint repository_intelligence_publication_identity_fkey
    foreign key (intelligence_version, repository_id, repository_revision)
    references public.repository_intelligence_versions(
      intelligence_version, repository_id, repository_revision
    ) on delete restrict,
  constraint repository_intelligence_publication_not_cyclic check (
    rollback_intelligence_version is null
    or rollback_intelligence_version <> intelligence_version
  )
);

create index if not exists repository_intelligence_versions_repository_status_idx
  on public.repository_intelligence_versions(repository_id, status, published_at desc);
create index if not exists repository_intelligence_versions_cleanup_idx
  on public.repository_intelligence_versions(repository_id, status, updated_at)
  where status in ('failed', 'superseded');
create index if not exists repository_intelligence_versions_building_idx
  on public.repository_intelligence_versions(repository_id, job_id)
  where status in ('building', 'validating');
create index if not exists repository_intelligence_subsystems_id_idx
  on public.repository_intelligence_subsystems(subsystem_id, intelligence_version);
create index if not exists repository_intelligence_diagnostics_version_idx
  on public.repository_intelligence_diagnostics(intelligence_version, created_at);
create index if not exists repository_intelligence_publications_revision_idx
  on public.repository_intelligence_publications(repository_id, repository_revision);

create or replace function public.enforce_repository_intelligence_immutability()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.intelligence_version is distinct from old.intelligence_version
    or new.repository_id is distinct from old.repository_id
    or new.repository_revision is distinct from old.repository_revision
    or new.graph_version is distinct from old.graph_version
    or new.embedding_version is distinct from old.embedding_version
    or new.parser_version is distinct from old.parser_version
    or new.analysis_version is distinct from old.analysis_version
    or new.schema_version is distinct from old.schema_version
    or new.created_at is distinct from old.created_at then
    raise check_violation using message = 'repository intelligence identity is immutable';
  end if;
  return new;
end; $$;

create trigger repository_intelligence_versions_immutable_trigger
before update on public.repository_intelligence_versions
for each row execute function public.enforce_repository_intelligence_immutability();

create or replace function public.begin_repository_intelligence_version(
  input_repository_id text, input_repository_revision text,
  input_intelligence_version text, input_graph_version text,
  input_embedding_version text, input_parser_version text,
  input_analysis_version text, input_job_id text,
  input_worker_id text, input_claim_token text
)
returns table(already_published boolean)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare existing public.repository_intelligence_versions%rowtype;
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and status = 'running' and lease_expires_at > now()
  for update;
  if not found then raise serialization_failure using message = 'indexing_job_lease_conflict'; end if;

  perform 1 from public.repository_graph_versions
  where graph_version = input_graph_version and repository_id = input_repository_id
    and repository_revision = input_repository_revision;
  if not found then raise check_violation using message = 'intelligence graph version mismatch'; end if;
  perform 1 from public.embedding_index_versions
  where embedding_version = input_embedding_version and repository_id = input_repository_id
    and repository_revision = input_repository_revision;
  if not found then raise check_violation using message = 'intelligence embedding version mismatch'; end if;

  select * into existing from public.repository_intelligence_versions
  where intelligence_version = input_intelligence_version for update;
  if found then
    if existing.repository_id is distinct from input_repository_id
      or existing.repository_revision is distinct from input_repository_revision
      or existing.graph_version is distinct from input_graph_version
      or existing.embedding_version is distinct from input_embedding_version
      or existing.parser_version is distinct from input_parser_version
      or existing.analysis_version is distinct from input_analysis_version then
      raise check_violation using message = 'repository intelligence version configuration mismatch';
    end if;
    if existing.status = 'published' and exists (
      select 1 from public.repository_intelligence_publications
      where repository_id = input_repository_id
        and intelligence_version = input_intelligence_version
        and repository_revision = input_repository_revision
    ) then return query select true; return; end if;
    if existing.status in ('building', 'validating') and existing.job_id <> input_job_id then
      raise serialization_failure using message = 'repository_intelligence_publication_in_progress';
    end if;
    delete from public.repository_intelligence_snapshots where intelligence_version = input_intelligence_version;
    delete from public.repository_intelligence_diagnostics where intelligence_version = input_intelligence_version;
    update public.repository_intelligence_versions
      set status = 'building', job_id = input_job_id, validated_at = null,
        published_at = null, updated_at = now()
      where intelligence_version = input_intelligence_version;
  else
    insert into public.repository_intelligence_versions(
      intelligence_version, repository_id, repository_revision, graph_version,
      embedding_version, parser_version, analysis_version, job_id, status
    ) values (
      input_intelligence_version, input_repository_id, input_repository_revision,
      input_graph_version, input_embedding_version, input_parser_version,
      input_analysis_version, input_job_id, 'building'
    );
  end if;
  return query select false;
end; $$;

create or replace function public.stage_repository_intelligence_version(
  input_repository_id text, input_repository_revision text,
  input_intelligence_version text, input_job_id text,
  input_worker_id text, input_claim_token text,
  input_snapshot jsonb, input_subsystems jsonb, input_metrics jsonb
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare subsystem jsonb;
declare previous_version text;
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and status = 'running' and lease_expires_at > now();
  if not found then raise serialization_failure using message = 'indexing_job_lease_conflict'; end if;
  perform 1 from public.repository_intelligence_versions
  where intelligence_version = input_intelligence_version
    and repository_id = input_repository_id and repository_revision = input_repository_revision
    and job_id = input_job_id and status = 'building' for update;
  if not found then raise check_violation using message = 'intelligence version is not building'; end if;
  if jsonb_typeof(input_snapshot) <> 'object'
    or jsonb_typeof(input_subsystems) <> 'array'
    or jsonb_typeof(input_metrics) <> 'object' then
    raise check_violation using message = 'invalid intelligence payload';
  end if;
  select intelligence_version into previous_version
    from public.repository_intelligence_publications where repository_id = input_repository_id;
  insert into public.repository_intelligence_snapshots(
    intelligence_version, snapshot, publication_metadata
  ) values (
    input_intelligence_version, input_snapshot,
    jsonb_build_object(
      'repositoryRevision', input_repository_revision,
      'graphVersion', input_snapshot->>'graphVersion',
      'embeddingVersion', input_snapshot->>'embeddingVersion',
      'previousIntelligenceVersion', previous_version
    )
  ) on conflict (intelligence_version) do update
    set snapshot = excluded.snapshot, publication_metadata = excluded.publication_metadata;
  delete from public.repository_intelligence_subsystems where intelligence_version = input_intelligence_version;
  for subsystem in select value from jsonb_array_elements(input_subsystems)
  loop
    insert into public.repository_intelligence_subsystems(intelligence_version, subsystem_id, summary)
    values (input_intelligence_version, subsystem->>'subsystemId', subsystem);
  end loop;
  insert into public.repository_intelligence_metrics(
    intelligence_version, files_analyzed, symbols_analyzed, dependency_edges_analyzed,
    generated_subsystems, quality_findings, hotspots
  ) values (
    input_intelligence_version, (input_metrics->>'filesAnalyzed')::integer,
    (input_metrics->>'symbolsAnalyzed')::integer,
    (input_metrics->>'dependencyEdgesAnalyzed')::integer,
    (input_metrics->>'generatedSubsystems')::integer,
    (input_metrics->>'qualityFindings')::integer, (input_metrics->>'hotspots')::integer
  ) on conflict (intelligence_version) do update set
    files_analyzed = excluded.files_analyzed, symbols_analyzed = excluded.symbols_analyzed,
    dependency_edges_analyzed = excluded.dependency_edges_analyzed,
    generated_subsystems = excluded.generated_subsystems,
    quality_findings = excluded.quality_findings, hotspots = excluded.hotspots;
end; $$;

create or replace function public.validate_repository_intelligence_version(
  input_repository_id text, input_repository_revision text,
  input_intelligence_version text, input_job_id text,
  input_worker_id text, input_claim_token text, input_max_bytes bigint
)
returns table(is_valid boolean, diagnostics jsonb, validated_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare problems jsonb := '[]'::jsonb;
declare checked_at timestamptz := now();
declare snapshot_row public.repository_intelligence_snapshots%rowtype;
declare metrics_row public.repository_intelligence_metrics%rowtype;
begin
  perform 1 from public.indexing_jobs where job_id = input_job_id
    and repository_id = input_repository_id and claimed_by = input_worker_id
    and claim_token = input_claim_token and status = 'running' and lease_expires_at > now();
  if not found then raise serialization_failure using message = 'indexing_job_lease_conflict'; end if;
  update public.repository_intelligence_versions set status = 'validating', updated_at = now()
    where intelligence_version = input_intelligence_version
      and repository_id = input_repository_id and repository_revision = input_repository_revision
      and job_id = input_job_id and status = 'building';
  if not found then raise check_violation using message = 'intelligence version is not ready for validation'; end if;
  select * into snapshot_row from public.repository_intelligence_snapshots
    where intelligence_version = input_intelligence_version;
  select * into metrics_row from public.repository_intelligence_metrics
    where intelligence_version = input_intelligence_version;
  if snapshot_row.snapshot is null then
    problems := problems || jsonb_build_array(jsonb_build_object('code','missing_snapshot','message','Snapshot is required.'));
  elsif octet_length(snapshot_row.snapshot::text) > input_max_bytes then
    raise check_violation using message = 'repository_quota_exceeded:artifact_size';
  end if;
  if coalesce(snapshot_row.snapshot->>'repositoryRevision','') = '' then
    problems := problems || jsonb_build_array(jsonb_build_object('code','missing_repository_revision','message','Revision is required.'));
  end if;
  if coalesce(snapshot_row.snapshot->>'graphVersion','') = '' then
    problems := problems || jsonb_build_array(jsonb_build_object('code','missing_graph_version','message','Graph version is required.'));
  end if;
  if (select count(*) from public.repository_intelligence_subsystems
      where intelligence_version = input_intelligence_version)
      <> coalesce(metrics_row.generated_subsystems, -1) then
    problems := problems || jsonb_build_array(jsonb_build_object('code','metric_inconsistency','message','Subsystem metric is inconsistent.'));
  end if;
  if coalesce(metrics_row.dependency_edges_analyzed, -1) <
      jsonb_array_length(coalesce(snapshot_row.snapshot->'architecture'->'dependencyGraph', '[]')) then
    problems := problems || jsonb_build_array(jsonb_build_object('code','metric_inconsistency','message','Dependency metric is inconsistent.'));
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(
      snapshot_row.snapshot->'architecture'->'dependencyGraph', '[]'
    )) edge
    where coalesce(edge->>'from','') = ''
      or coalesce(edge->>'to','') = ''
      or edge->>'from' = edge->>'to'
      or coalesce((edge->>'count')::integer, 0) < 1
      or not exists (
        select 1 from public.repository_intelligence_subsystems subsystem
        where subsystem.intelligence_version = input_intelligence_version
          and subsystem.subsystem_id = edge->>'from'
      )
      or not exists (
        select 1 from public.repository_intelligence_subsystems subsystem
        where subsystem.intelligence_version = input_intelligence_version
          and subsystem.subsystem_id = edge->>'to'
      )
  ) then
    problems := problems || jsonb_build_array(jsonb_build_object('code','invalid_dependency_graph','message','Dependency graph is invalid.'));
  end if;
  if exists (
    select 1 from public.repository_intelligence_subsystems subsystem
    cross join lateral jsonb_array_elements_text(coalesce(subsystem.summary->'dependencies','[]')) dependency
    where subsystem.intelligence_version = input_intelligence_version
      and not exists (
        select 1 from public.repository_intelligence_subsystems target
        where target.intelligence_version = input_intelligence_version
          and target.subsystem_id = dependency.value
      )
  ) then
    problems := problems || jsonb_build_array(jsonb_build_object('code','orphan_subsystem_reference','message','Subsystem reference is invalid.'));
  end if;
  if snapshot_row.publication_metadata->>'previousIntelligenceVersion' = input_intelligence_version then
    problems := problems || jsonb_build_array(jsonb_build_object('code','cyclic_publication_metadata','message','Publication metadata is cyclic.'));
  end if;
  delete from public.repository_intelligence_diagnostics where intelligence_version = input_intelligence_version;
  insert into public.repository_intelligence_diagnostics(intelligence_version, code, message, details)
    select input_intelligence_version, item->>'code', item->>'message', item
    from jsonb_array_elements(problems) item;
  update public.repository_intelligence_versions
    set status = case when jsonb_array_length(problems) = 0 then 'validating' else 'failed' end,
      validated_at = checked_at, updated_at = now()
    where intelligence_version = input_intelligence_version;
  return query select jsonb_array_length(problems) = 0, problems, checked_at;
end; $$;

create or replace function public.fail_repository_intelligence_version(
  input_repository_id text, input_intelligence_version text,
  input_job_id text, input_diagnostics jsonb
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare diagnostic jsonb;
begin
  update public.repository_intelligence_versions set status = 'failed', updated_at = now()
  where intelligence_version = input_intelligence_version and repository_id = input_repository_id
    and job_id = input_job_id and status in ('building', 'validating');
  if found then
    for diagnostic in select value from jsonb_array_elements(coalesce(input_diagnostics, '[]'))
    loop
      insert into public.repository_intelligence_diagnostics(intelligence_version, code, message, details)
      values (
        input_intelligence_version, coalesce(diagnostic->>'code','intelligence_failed'),
        coalesce(diagnostic->>'message','Intelligence generation failed.'), diagnostic
      );
    end loop;
  end if;
end; $$;

create or replace function public.get_published_repository_intelligence(
  input_repository_id text, input_repository_revision text default null
)
returns table(
  intelligence_version text, repository_id text, repository_revision text,
  graph_version text, embedding_version text, parser_version text,
  analysis_version text, status text, snapshot jsonb, publication_metadata jsonb,
  created_at timestamptz, validated_at timestamptz, published_at timestamptz
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select versions.intelligence_version, versions.repository_id, versions.repository_revision,
    versions.graph_version, versions.embedding_version, versions.parser_version,
    versions.analysis_version, versions.status, snapshots.snapshot,
    snapshots.publication_metadata, versions.created_at, versions.validated_at, versions.published_at
  from public.repository_intelligence_publications publications
  join public.repository_intelligence_versions versions
    on versions.intelligence_version = publications.intelligence_version
  join public.repository_intelligence_snapshots snapshots
    on snapshots.intelligence_version = versions.intelligence_version
  where publications.repository_id = input_repository_id
    and (input_repository_revision is null or publications.repository_revision = input_repository_revision)
    and versions.status = 'published';
$$;

create or replace function public.collect_repository_intelligence_versions(
  input_repository_id text, input_retention_count integer
)
returns table(deleted_count integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare removed integer;
begin
  if input_retention_count < 2 then raise check_violation using message = 'retention must preserve rollback intelligence'; end if;
  perform pg_advisory_xact_lock(hashtextextended(input_repository_id || ':intelligence-gc', 0));
  with protected as (
    select intelligence_version from public.repository_intelligence_publications
    where repository_id = input_repository_id
    union
    select rollback_intelligence_version from public.repository_intelligence_publications
    where repository_id = input_repository_id and rollback_intelligence_version is not null
    union
    select intelligence_version from public.repository_intelligence_versions
    where repository_id = input_repository_id and status in ('building', 'validating')
  ), retained_history as (
    select intelligence_version from public.repository_intelligence_versions
    where repository_id = input_repository_id and status in ('published', 'superseded')
    order by published_at desc nulls last, created_at desc, intelligence_version
    limit input_retention_count
  ), deleted as (
    delete from public.repository_intelligence_versions versions
    where versions.repository_id = input_repository_id
      and versions.status in ('failed', 'superseded')
      and not exists (select 1 from protected where protected.intelligence_version = versions.intelligence_version)
      and not exists (
        select 1 from retained_history
        where retained_history.intelligence_version = versions.intelligence_version
      )
    returning 1
  ) select count(*) into removed from deleted;
  return query select removed;
end; $$;

create or replace function public.recover_repository_intelligence_versions()
returns table(recovered_count integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare recovered integer;
begin
  with recovered_rows as (
    update public.repository_intelligence_versions set status = 'failed', updated_at = now()
    where status in ('building', 'validating')
      and not exists (
        select 1 from public.indexing_jobs jobs
        where jobs.job_id = repository_intelligence_versions.job_id
          and jobs.status = 'running' and jobs.lease_expires_at > now()
      )
    returning intelligence_version
  ), diagnostics as (
    insert into public.repository_intelligence_diagnostics(intelligence_version, code, message)
      select intelligence_version, 'startup_recovery', 'Interrupted intelligence build.'
      from recovered_rows returning 1
  ) select count(*) into recovered from diagnostics;
  return query select recovered;
end; $$;

create or replace function public.verify_repository_intelligence_contract(input_analysis_version text)
returns table(valid boolean)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if input_analysis_version <> 'repository-intelligence-v1' then
    raise check_violation using message = 'repository intelligence analysis version is incompatible';
  end if;
  if to_regclass('public.repository_intelligence_versions') is null
    or to_regclass('public.repository_intelligence_snapshots') is null
    or to_regclass('public.repository_intelligence_subsystems') is null
    or to_regclass('public.repository_intelligence_metrics') is null
    or to_regclass('public.repository_intelligence_diagnostics') is null
    or to_regclass('public.repository_intelligence_publications') is null then
    raise check_violation using message = 'repository intelligence tables are missing';
  end if;
  if exists (
    select 1 from public.repository_intelligence_publications publication
    left join public.repository_intelligence_versions version
      on version.intelligence_version = publication.intelligence_version
    where version.status is distinct from 'published'
      or version.repository_revision is distinct from publication.repository_revision
      or version.graph_version is distinct from publication.graph_version
      or version.embedding_version is distinct from publication.embedding_version
  ) then raise check_violation using message = 'repository intelligence publication integrity is invalid'; end if;
  if exists (
    select 1 from public.repository_intelligence_publications publication
    join public.repository_intelligence_versions version
      on version.intelligence_version = publication.intelligence_version
    where version.analysis_version <> input_analysis_version
      or version.schema_version <> 'repository-intelligence-schema-v1'
  ) then raise check_violation using message = 'published repository intelligence version is incompatible'; end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'repository_intelligence_versions_repository_status_idx'
  ) or not exists (
    select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'repository_intelligence_versions_cleanup_idx'
  ) then raise check_violation using message = 'repository intelligence indexes are missing'; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.repository_intelligence_versions'::regclass
      and conname = 'repository_intelligence_versions_status_valid'
  ) or not exists (
    select 1 from pg_constraint
    where conrelid = 'public.repository_intelligence_publications'::regclass
      and conname = 'repository_intelligence_publication_not_cyclic'
  ) then raise check_violation using message = 'repository intelligence constraints are missing'; end if;
  if exists (
    select 1 from pg_class relation
    where relation.oid in (
      'public.repository_intelligence_versions'::regclass,
      'public.repository_intelligence_snapshots'::regclass,
      'public.repository_intelligence_subsystems'::regclass,
      'public.repository_intelligence_metrics'::regclass,
      'public.repository_intelligence_diagnostics'::regclass,
      'public.repository_intelligence_publications'::regclass
    ) and not relation.relrowsecurity
  ) then raise check_violation using message = 'repository intelligence RLS is not enabled'; end if;
  if has_table_privilege('anon', 'public.repository_intelligence_versions', 'select')
    or has_table_privilege('authenticated', 'public.repository_intelligence_versions', 'select')
    or not has_table_privilege('service_role', 'public.repository_intelligence_versions', 'select')
    or not has_function_privilege(
      'service_role',
      'public.get_published_repository_intelligence(text,text)',
      'execute'
    ) then raise check_violation using message = 'repository intelligence grants are invalid'; end if;
  return query select true;
end; $$;

do $migration$
begin
  if to_regprocedure(
    'public.publish_repository_snapshot_without_intelligence(text,text,text,text,text,text,integer,integer,integer,integer,integer,boolean,text,text,integer,text,bigint,integer,bigint)'
  ) is null then
    alter function public.publish_repository_snapshot(
      text,text,text,text,text,text,integer,integer,integer,integer,integer,
      boolean,text,text,integer,text,bigint,integer,bigint
    ) rename to publish_repository_snapshot_without_intelligence;
  end if;
end;
$migration$;

create or replace function public.publish_repository_snapshot(
  input_repository_id text, input_revision text, input_branch text,
  input_job_id text, input_worker_id text, input_claim_token text,
  input_chunk_count integer, input_file_count integer, input_symbol_count integer,
  input_graph_node_count integer, input_graph_edge_count integer,
  input_summary_available boolean, input_embedding_version text,
  input_intelligence_version text, input_index_mode text,
  input_changed_file_count integer, input_owner_user_id text,
  input_repository_storage_bytes bigint, input_max_indexed_repositories integer,
  input_max_user_storage_bytes bigint
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare intelligence_row public.repository_intelligence_versions%rowtype;
declare previous_version text;
begin
  select * into intelligence_row from public.repository_intelligence_versions
  where intelligence_version = input_intelligence_version
    and repository_id = input_repository_id and repository_revision = input_revision
    and embedding_version = input_embedding_version
    and validated_at is not null
    and (
      (status = 'validating' and job_id = input_job_id)
      or (
        status = 'published'
        and exists (
          select 1 from public.repository_intelligence_publications publications
          where publications.repository_id = input_repository_id
            and publications.repository_revision = input_revision
            and publications.intelligence_version = input_intelligence_version
        )
      )
    )
    and exists (
      select 1 from public.repository_graph_versions graph
      where graph.graph_version = repository_intelligence_versions.graph_version
        and graph.repository_id = input_repository_id
        and graph.repository_revision = input_revision
        and (
          (graph.status = 'validating' and graph.job_id = input_job_id)
          or (
            graph.status = 'published'
            and exists (
              select 1 from public.repository_graph_publications publication
              where publication.repository_id = input_repository_id
                and publication.repository_revision = input_revision
                and publication.graph_version = graph.graph_version
            )
          )
        )
    )
  for update;
  if not found then raise check_violation using message = 'validated repository intelligence is required for publication'; end if;
  if exists (
    select 1 from public.repository_intelligence_diagnostics
    where intelligence_version = input_intelligence_version and severity = 'error'
  ) then raise check_violation using message = 'repository intelligence has validation diagnostics'; end if;

  perform public.publish_repository_snapshot_without_intelligence(
    input_repository_id, input_revision, input_branch, input_job_id,
    input_worker_id, input_claim_token, input_chunk_count, input_file_count,
    input_symbol_count, input_graph_node_count, input_graph_edge_count,
    input_summary_available, input_embedding_version, input_index_mode,
    input_changed_file_count, input_owner_user_id, input_repository_storage_bytes,
    input_max_indexed_repositories, input_max_user_storage_bytes
  );

  select intelligence_version into previous_version
    from public.repository_intelligence_publications where repository_id = input_repository_id;
  if previous_version is not null and previous_version <> input_intelligence_version then
    update public.repository_intelligence_versions set status = 'superseded',
      published_at = null, updated_at = now() where intelligence_version = previous_version;
  end if;
  update public.repository_intelligence_versions set status = 'published',
    published_at = coalesce(published_at, now()), updated_at = now()
    where intelligence_version = input_intelligence_version;
  insert into public.repository_intelligence_publications(
    repository_id, repository_revision, intelligence_version, graph_version,
    embedding_version, published_at, rollback_intelligence_version
  ) values (
    input_repository_id, input_revision, input_intelligence_version,
    intelligence_row.graph_version, input_embedding_version, now(), previous_version
  ) on conflict (repository_id) do update set
    repository_revision = excluded.repository_revision,
    intelligence_version = excluded.intelligence_version,
    graph_version = excluded.graph_version,
    embedding_version = excluded.embedding_version,
    published_at = excluded.published_at,
    rollback_intelligence_version = case
      when repository_intelligence_publications.intelligence_version <> excluded.intelligence_version
      then repository_intelligence_publications.intelligence_version
      else repository_intelligence_publications.rollback_intelligence_version end;
end; $$;

-- Preserve the previous worker contract while ensuring legacy callers cannot
-- publish a revision without its validated intelligence.
create or replace function public.publish_repository_snapshot(
  input_repository_id text, input_revision text, input_branch text,
  input_job_id text, input_worker_id text, input_claim_token text,
  input_chunk_count integer, input_file_count integer, input_symbol_count integer,
  input_graph_node_count integer, input_graph_edge_count integer,
  input_summary_available boolean, input_embedding_version text,
  input_index_mode text, input_changed_file_count integer,
  input_owner_user_id text, input_repository_storage_bytes bigint,
  input_max_indexed_repositories integer, input_max_user_storage_bytes bigint
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare compatibility_intelligence_version text;
declare graph_row public.repository_graph_versions%rowtype;
declare compatibility_snapshot jsonb;
begin
  select versions.intelligence_version into compatibility_intelligence_version
  from public.repository_intelligence_versions versions
  where versions.repository_id = input_repository_id
    and versions.repository_revision = input_revision
    and versions.embedding_version = input_embedding_version
    and versions.status = 'validating' and versions.job_id = input_job_id
  order by versions.created_at desc limit 1;
  if compatibility_intelligence_version is null then
    select versions.* into graph_row
    from public.repository_graph_versions versions
    where versions.repository_id = input_repository_id
      and versions.repository_revision = input_revision
      and versions.status = 'validating' and versions.job_id = input_job_id
    order by versions.created_at desc limit 1;
    if not found then
      raise check_violation using message = 'validated repository graph is required for intelligence publication';
    end if;
    compatibility_intelligence_version := 'ri-compat-' || md5(
      input_revision || ':' || graph_row.graph_version || ':' ||
      input_embedding_version || ':' || graph_row.parser_version ||
      ':repository-intelligence-v1'
    );
    compatibility_snapshot := jsonb_build_object(
      'intelligenceVersion', compatibility_intelligence_version,
      'repositoryId', input_repository_id,
      'repositoryRevision', input_revision,
      'graphVersion', graph_row.graph_version,
      'embeddingVersion', input_embedding_version,
      'parserVersion', graph_row.parser_version,
      'analysisVersion', 'repository-intelligence-v1',
      'schemaVersion', 'repository-intelligence-schema-v1',
      'architecture', jsonb_build_object(
        'subsystemIds', '[]'::jsonb, 'packageHierarchy', '[]'::jsonb,
        'dependencyGraph', '[]'::jsonb, 'layers', '[]'::jsonb, 'hotspots', '[]'::jsonb
      ),
      'codeOrganization', jsonb_build_object(
        'largestModules', '[]'::jsonb, 'mostImportedFiles', '[]'::jsonb,
        'highestFanIn', '[]'::jsonb, 'highestFanOut', '[]'::jsonb,
        'cyclicDependencies', '[]'::jsonb, 'utilityClusters', '[]'::jsonb
      ),
      'symbols', jsonb_build_object(
        'publicApis', '[]'::jsonb, 'internalApis', '[]'::jsonb,
        'orphanSymbols', '[]'::jsonb, 'deadExports', '[]'::jsonb,
        'entrypoints', '[]'::jsonb, 'sharedAbstractions', '[]'::jsonb
      ),
      'quality', jsonb_build_object(
        'duplicateImplementations', '[]'::jsonb, 'oversizedFiles', '[]'::jsonb,
        'oversizedFunctions', '[]'::jsonb, 'todoFixmeDensity', 0,
        'generatedCodeRatio', 0, 'documentationCoverage', 0
      ),
      'evolution', jsonb_build_object(
        'changedHotspots', '[]'::jsonb, 'stableAreas', '[]'::jsonb,
        'architecturalDrift', '[]'::jsonb,
        'growth', jsonb_build_object(
          'files', input_file_count, 'symbols', input_symbol_count,
          'dependencyEdges', input_graph_edge_count, 'fileDelta', 0,
          'symbolDelta', 0, 'dependencyEdgeDelta', 0
        )
      ),
      'subsystems', '[]'::jsonb,
      'metrics', jsonb_build_object(
        'filesAnalyzed', input_file_count, 'symbolsAnalyzed', input_symbol_count,
        'dependencyEdgesAnalyzed', input_graph_edge_count, 'generatedSubsystems', 0,
        'qualityFindings', 0, 'hotspots', 0
      )
    );
    insert into public.repository_intelligence_versions(
      intelligence_version, repository_id, repository_revision, graph_version,
      embedding_version, parser_version, analysis_version, job_id, status, validated_at
    ) values (
      compatibility_intelligence_version, input_repository_id, input_revision, graph_row.graph_version,
      input_embedding_version, graph_row.parser_version, 'repository-intelligence-v1',
      input_job_id, 'validating', now()
    ) on conflict (intelligence_version) do update set
      status = 'validating', job_id = excluded.job_id, validated_at = excluded.validated_at,
      updated_at = now();
    insert into public.repository_intelligence_snapshots(
      intelligence_version, snapshot, publication_metadata
    ) values (
      compatibility_intelligence_version, compatibility_snapshot,
      jsonb_build_object(
        'repositoryRevision', input_revision, 'graphVersion', graph_row.graph_version,
        'embeddingVersion', input_embedding_version, 'previousIntelligenceVersion', null
      )
    ) on conflict (intelligence_version) do update set snapshot = excluded.snapshot;
    insert into public.repository_intelligence_metrics(
      intelligence_version, files_analyzed, symbols_analyzed,
      dependency_edges_analyzed, generated_subsystems, quality_findings, hotspots
    ) values (
      compatibility_intelligence_version, input_file_count, input_symbol_count,
      input_graph_edge_count, 0, 0, 0
    ) on conflict (intelligence_version) do nothing;
  end if;
  perform public.publish_repository_snapshot(
    input_repository_id, input_revision, input_branch, input_job_id,
    input_worker_id, input_claim_token, input_chunk_count, input_file_count,
    input_symbol_count, input_graph_node_count, input_graph_edge_count,
    input_summary_available, input_embedding_version, compatibility_intelligence_version,
    input_index_mode, input_changed_file_count, input_owner_user_id,
    input_repository_storage_bytes, input_max_indexed_repositories,
    input_max_user_storage_bytes
  );
end; $$;

alter table public.repository_intelligence_versions enable row level security;
alter table public.repository_intelligence_snapshots enable row level security;
alter table public.repository_intelligence_subsystems enable row level security;
alter table public.repository_intelligence_metrics enable row level security;
alter table public.repository_intelligence_diagnostics enable row level security;
alter table public.repository_intelligence_publications enable row level security;

revoke all on table public.repository_intelligence_versions,
  public.repository_intelligence_snapshots, public.repository_intelligence_subsystems,
  public.repository_intelligence_metrics, public.repository_intelligence_diagnostics,
  public.repository_intelligence_publications from public, anon, authenticated;
grant all on table public.repository_intelligence_versions,
  public.repository_intelligence_snapshots, public.repository_intelligence_subsystems,
  public.repository_intelligence_metrics, public.repository_intelligence_diagnostics,
  public.repository_intelligence_publications to service_role;
grant usage, select on sequence public.repository_intelligence_diagnostics_diagnostic_id_seq to service_role;

revoke all on function public.begin_repository_intelligence_version(text,text,text,text,text,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.stage_repository_intelligence_version(text,text,text,text,text,text,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
revoke all on function public.validate_repository_intelligence_version(text,text,text,text,text,text,bigint)
  from public, anon, authenticated;
revoke all on function public.fail_repository_intelligence_version(text,text,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.get_published_repository_intelligence(text,text)
  from public, anon, authenticated;
revoke all on function public.collect_repository_intelligence_versions(text,integer)
  from public, anon, authenticated;
revoke all on function public.recover_repository_intelligence_versions()
  from public, anon, authenticated;
revoke all on function public.verify_repository_intelligence_contract(text)
  from public, anon, authenticated;
revoke all on function public.publish_repository_snapshot_without_intelligence(
  text,text,text,text,text,text,integer,integer,integer,integer,integer,
  boolean,text,text,integer,text,bigint,integer,bigint
) from public, anon, authenticated, service_role;
revoke all on function public.publish_repository_snapshot(
  text,text,text,text,text,text,integer,integer,integer,integer,integer,
  boolean,text,text,text,integer,text,bigint,integer,bigint
) from public, anon, authenticated;
revoke all on function public.publish_repository_snapshot(
  text,text,text,text,text,text,integer,integer,integer,integer,integer,
  boolean,text,text,integer,text,bigint,integer,bigint
) from public, anon, authenticated;

grant execute on function public.begin_repository_intelligence_version(text,text,text,text,text,text,text,text,text,text)
  to service_role;
grant execute on function public.stage_repository_intelligence_version(text,text,text,text,text,text,jsonb,jsonb,jsonb)
  to service_role;
grant execute on function public.validate_repository_intelligence_version(text,text,text,text,text,text,bigint)
  to service_role;
grant execute on function public.fail_repository_intelligence_version(text,text,text,jsonb)
  to service_role;
grant execute on function public.get_published_repository_intelligence(text,text)
  to service_role;
grant execute on function public.collect_repository_intelligence_versions(text,integer)
  to service_role;
grant execute on function public.recover_repository_intelligence_versions()
  to service_role;
grant execute on function public.verify_repository_intelligence_contract(text)
  to service_role;
grant execute on function public.publish_repository_snapshot(
  text,text,text,text,text,text,integer,integer,integer,integer,integer,
  boolean,text,text,text,integer,text,bigint,integer,bigint
) to service_role;
grant execute on function public.publish_repository_snapshot(
  text,text,text,text,text,text,integer,integer,integer,integer,integer,
  boolean,text,text,integer,text,bigint,integer,bigint
) to service_role;
