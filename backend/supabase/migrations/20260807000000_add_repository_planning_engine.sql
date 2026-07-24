create table if not exists public.repository_plan_versions (
  plan_version text primary key,
  task_hash text not null,
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  repository_revision text not null,
  intelligence_version text not null
    references public.repository_intelligence_versions(intelligence_version) on delete cascade,
  graph_version text not null references public.repository_graph_versions(graph_version) on delete cascade,
  embedding_version text not null references public.embedding_index_versions(embedding_version) on delete cascade,
  planner_version text not null,
  schema_version text not null,
  status text not null,
  plan jsonb,
  affected_files jsonb not null default '[]'::jsonb,
  ordered_phases jsonb not null default '[]'::jsonb,
  validation_context jsonb not null default '{}'::jsonb,
  publication_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint repository_plan_versions_identity_unique
    unique (plan_version, repository_id, task_hash),
  constraint repository_plan_versions_revision_fkey
    foreign key (repository_id, repository_revision)
    references public.repository_snapshots(repository_id, revision) on delete cascade,
  constraint repository_plan_versions_configuration_unique
    unique (
      repository_id, task_hash, repository_revision, intelligence_version,
      graph_version, embedding_version, planner_version
    ),
  constraint repository_plan_versions_status_valid
    check (status in ('building', 'validating', 'published', 'failed', 'superseded')),
  constraint repository_plan_versions_identity_present check (
    btrim(plan_version) <> '' and btrim(task_hash) <> ''
    and btrim(repository_revision) <> '' and btrim(intelligence_version) <> ''
    and btrim(graph_version) <> '' and btrim(embedding_version) <> ''
    and btrim(planner_version) <> '' and btrim(schema_version) <> ''
  ),
  constraint repository_plan_versions_json_shapes check (
    (plan is null or jsonb_typeof(plan) = 'object')
    and jsonb_typeof(affected_files) = 'array'
    and jsonb_typeof(ordered_phases) = 'array'
    and jsonb_typeof(validation_context) = 'object'
    and jsonb_typeof(publication_metadata) = 'object'
  ),
  constraint repository_plan_versions_publication_timestamp check (
    status <> 'published' or published_at is not null
  )
);

create table if not exists public.repository_plans (
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  task_hash text not null,
  plan_version text not null unique,
  rollback_plan_version text,
  repository_revision text not null,
  published_at timestamptz not null,
  primary key (repository_id, task_hash),
  constraint repository_plans_current_identity_fkey
    foreign key (plan_version, repository_id, task_hash)
    references public.repository_plan_versions(plan_version, repository_id, task_hash)
    on delete restrict,
  constraint repository_plans_rollback_not_current check (
    rollback_plan_version is null or rollback_plan_version <> plan_version
  )
);

create table if not exists public.repository_plan_diagnostics (
  diagnostic_id bigint generated always as identity primary key,
  plan_version text not null
    references public.repository_plan_versions(plan_version) on delete cascade,
  severity text not null default 'error',
  code text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint repository_plan_diagnostics_severity_valid
    check (severity in ('info', 'warning', 'error')),
  constraint repository_plan_diagnostics_present
    check (btrim(code) <> '' and btrim(message) <> ''),
  constraint repository_plan_diagnostics_details_object
    check (jsonb_typeof(details) = 'object')
);

create index if not exists repository_plan_versions_repository_task_status_idx
  on public.repository_plan_versions(repository_id, task_hash, status, published_at desc);
create index if not exists repository_plan_versions_cleanup_idx
  on public.repository_plan_versions(repository_id, task_hash, status, updated_at)
  where status in ('failed', 'superseded');
create index if not exists repository_plan_versions_building_idx
  on public.repository_plan_versions(repository_id, status, created_at)
  where status in ('building', 'validating');
create index if not exists repository_plans_revision_idx
  on public.repository_plans(repository_id, repository_revision, published_at desc);
create index if not exists repository_plan_diagnostics_version_idx
  on public.repository_plan_diagnostics(plan_version, created_at);

create or replace function public.enforce_repository_plan_identity_immutability()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.plan_version is distinct from old.plan_version
    or new.task_hash is distinct from old.task_hash
    or new.repository_id is distinct from old.repository_id
    or new.repository_revision is distinct from old.repository_revision
    or new.intelligence_version is distinct from old.intelligence_version
    or new.graph_version is distinct from old.graph_version
    or new.embedding_version is distinct from old.embedding_version
    or new.planner_version is distinct from old.planner_version
    or new.schema_version is distinct from old.schema_version
    or new.created_at is distinct from old.created_at then
    raise check_violation using message = 'repository plan identity is immutable';
  end if;
  return new;
end; $$;

create trigger repository_plan_versions_immutable_identity_trigger
before update on public.repository_plan_versions
for each row execute function public.enforce_repository_plan_identity_immutability();

create or replace function public.begin_repository_plan_version(
  input_plan_version text, input_task_hash text, input_repository_id text,
  input_repository_revision text, input_intelligence_version text,
  input_graph_version text, input_embedding_version text,
  input_planner_version text, input_schema_version text
)
returns table(already_published boolean)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare existing public.repository_plan_versions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    input_repository_id || ':plan:' || input_task_hash, 0
  ));
  perform 1 from public.repository_intelligence_versions intelligence
  where intelligence.intelligence_version = input_intelligence_version
    and intelligence.repository_id = input_repository_id
    and intelligence.repository_revision = input_repository_revision
    and intelligence.graph_version = input_graph_version
    and intelligence.embedding_version = input_embedding_version
    and intelligence.status = 'published';
  if not found then
    raise check_violation using message = 'published repository intelligence is required for planning';
  end if;
  select * into existing from public.repository_plan_versions
  where plan_version = input_plan_version for update;
  if found then
    if existing.task_hash is distinct from input_task_hash
      or existing.repository_id is distinct from input_repository_id
      or existing.repository_revision is distinct from input_repository_revision
      or existing.intelligence_version is distinct from input_intelligence_version
      or existing.graph_version is distinct from input_graph_version
      or existing.embedding_version is distinct from input_embedding_version
      or existing.planner_version is distinct from input_planner_version
      or existing.schema_version is distinct from input_schema_version then
      raise check_violation using message = 'repository plan version configuration mismatch';
    end if;
    if existing.status = 'published' and exists (
      select 1 from public.repository_plans plans
      where plans.repository_id = input_repository_id
        and plans.task_hash = input_task_hash
        and plans.plan_version = input_plan_version
    ) then return query select true; return; end if;
    if existing.status in ('building', 'validating') then
      raise serialization_failure using message = 'repository_plan_publication_in_progress';
    end if;
    delete from public.repository_plan_diagnostics where plan_version = input_plan_version;
    update public.repository_plan_versions set
      status = 'building', plan = null, affected_files = '[]'::jsonb,
      ordered_phases = '[]'::jsonb, validation_context = '{}'::jsonb,
      publication_metadata = '{}'::jsonb, validated_at = null,
      published_at = null, updated_at = now()
    where plan_version = input_plan_version;
  else
    insert into public.repository_plan_versions(
      plan_version, task_hash, repository_id, repository_revision,
      intelligence_version, graph_version, embedding_version,
      planner_version, schema_version, status
    ) values (
      input_plan_version, input_task_hash, input_repository_id,
      input_repository_revision, input_intelligence_version, input_graph_version,
      input_embedding_version, input_planner_version, input_schema_version, 'building'
    );
  end if;
  return query select false;
end; $$;

create or replace function public.stage_repository_plan_version(
  input_plan_version text, input_plan jsonb, input_affected_files jsonb,
  input_ordered_phases jsonb, input_validation_context jsonb
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare previous_version text;
begin
  if jsonb_typeof(input_plan) <> 'object'
    or jsonb_typeof(input_affected_files) <> 'array'
    or jsonb_typeof(input_ordered_phases) <> 'array'
    or jsonb_typeof(input_validation_context) <> 'object' then
    raise check_violation using message = 'invalid repository plan payload';
  end if;
  select plans.plan_version into previous_version
  from public.repository_plans plans
  join public.repository_plan_versions version
    on version.plan_version = plans.plan_version
  where plans.repository_id = input_plan->>'repositoryId'
    and plans.task_hash = input_plan->>'taskHash';
  update public.repository_plan_versions set
    plan = input_plan, affected_files = input_affected_files,
    ordered_phases = input_ordered_phases,
    validation_context = input_validation_context,
    publication_metadata = jsonb_build_object(
      'previousPlanVersion', previous_version,
      'repositoryRevision', input_plan->>'repositoryRevision',
      'intelligenceVersion', input_plan->>'intelligenceVersion',
      'graphVersion', input_plan->>'graphVersion',
      'embeddingVersion', input_plan->>'embeddingVersion'
    ),
    updated_at = now()
  where plan_version = input_plan_version and status = 'building'
    and plan_version = input_plan->>'planVersion';
  if not found then raise check_violation using message = 'repository plan is not building'; end if;
end; $$;

create or replace function public.validate_repository_plan_version(input_plan_version text)
returns table(is_valid boolean, diagnostics jsonb, validated_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare version_row public.repository_plan_versions%rowtype;
declare problems jsonb := '[]'::jsonb;
declare checked_at timestamptz := now();
begin
  select * into version_row from public.repository_plan_versions
  where plan_version = input_plan_version and status = 'building' for update;
  if not found then raise check_violation using message = 'repository plan is not ready for validation'; end if;
  update public.repository_plan_versions set status = 'validating', updated_at = now()
    where plan_version = input_plan_version;
  if version_row.plan is null then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','missing_plan','message','Repository plan payload is required.'
    ));
  end if;
  if exists (
    select phase->>'phaseId' from jsonb_array_elements(version_row.ordered_phases) phase
    group by phase->>'phaseId' having count(*) > 1
  ) then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','duplicate_phase','message','Implementation phase IDs must be unique.'
    ));
  end if;
  if exists (
    select 1 from jsonb_array_elements(version_row.ordered_phases) phase
    cross join lateral jsonb_array_elements_text(coalesce(phase->'dependsOn','[]')) dependency
    where dependency.value = phase->>'phaseId'
      or not exists (
        select 1 from jsonb_array_elements(version_row.ordered_phases) target
        where target->>'phaseId' = dependency.value
      )
  ) then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','impossible_dependency','message','A phase dependency is missing or self-referential.'
    ));
  end if;
  if exists (
    select 1 from jsonb_array_elements(version_row.ordered_phases) phase
    cross join lateral jsonb_array_elements_text(coalesce(phase->'dependsOn','[]')) dependency
    join lateral (
      select target from jsonb_array_elements(version_row.ordered_phases) target
      where target->>'phaseId' = dependency.value
    ) target_phase on true
    where coalesce((target_phase.target->>'order')::integer, -1)
      >= coalesce((phase->>'order')::integer, -1)
  ) then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','invalid_ordering','message','A phase appears before its prerequisite.'
    ));
  end if;
  if exists (
    with recursive phase_edges as (
      select phase->>'phaseId' as source, dependency.value as target
      from jsonb_array_elements(version_row.ordered_phases) phase
      cross join lateral jsonb_array_elements_text(coalesce(phase->'dependsOn','[]')) dependency
    ), paths(source, target, visited) as (
      select source, target, array[source, target] from phase_edges
      union all
      select paths.source, phase_edges.target, paths.visited || phase_edges.target
      from paths join phase_edges on phase_edges.source = paths.target
      where not phase_edges.target = any(paths.visited)
    )
    select 1 from paths join phase_edges on phase_edges.source = paths.target
    where phase_edges.target = paths.source
  ) then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','circular_plan','message','Implementation phases contain a cycle.'
    ));
  end if;
  if exists (
    select 1 from jsonb_array_elements(version_row.affected_files) affected
    where not coalesce(version_row.validation_context->'knownFiles','[]')
      @> jsonb_build_array(affected->>'path')
  ) then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','missing_file','message','An affected file is missing from the graph.'
    ));
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(version_row.plan->'affectedSymbols','[]')) symbol
    where not coalesce(version_row.validation_context->'knownNodeIds','[]')
      @> jsonb_build_array(symbol->>'nodeId')
  ) then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','missing_symbol','message','An affected symbol is missing from the graph.'
    ));
  end if;
  if exists (
    select 1 from jsonb_each(coalesce(version_row.plan->'riskAnalysis','{}')) risk
    where risk.key <> 'level' and (
      jsonb_typeof(risk.value) <> 'number'
      or (risk.value::text)::double precision < 0
      or (risk.value::text)::double precision > 1
    )
  ) then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','inconsistent_risk','message','Risk values must be between zero and one.'
    ));
  end if;
  if jsonb_typeof(version_row.plan->'confidenceScore') is distinct from 'number'
    or ((version_row.plan->>'confidenceScore')::double precision) < 0
    or ((version_row.plan->>'confidenceScore')::double precision) > 1 then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','inconsistent_confidence','message','Confidence score must be between zero and one.'
    ));
  end if;
  if version_row.publication_metadata->>'previousPlanVersion' = input_plan_version then
    problems := problems || jsonb_build_array(jsonb_build_object(
      'code','cyclic_publication_metadata','message','Publication metadata is cyclic.'
    ));
  end if;
  delete from public.repository_plan_diagnostics where plan_version = input_plan_version;
  insert into public.repository_plan_diagnostics(plan_version, code, message, details)
    select input_plan_version, item->>'code', item->>'message', item
    from jsonb_array_elements(problems) item;
  update public.repository_plan_versions set
    status = case when jsonb_array_length(problems) = 0 then 'validating' else 'failed' end,
    validated_at = checked_at, updated_at = now()
  where plan_version = input_plan_version;
  return query select jsonb_array_length(problems) = 0, problems, checked_at;
end; $$;

create or replace function public.publish_repository_plan_version(input_plan_version text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare version_row public.repository_plan_versions%rowtype;
declare previous_version text;
begin
  select * into version_row from public.repository_plan_versions
  where plan_version = input_plan_version and status in ('validating','published')
    and validated_at is not null for update;
  if not found then raise check_violation using message = 'validated repository plan is required'; end if;
  if exists (
    select 1 from public.repository_plan_diagnostics
    where plan_version = input_plan_version and severity = 'error'
  ) then raise check_violation using message = 'repository plan has validation diagnostics'; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    version_row.repository_id || ':plan:' || version_row.task_hash, 0
  ));
  select plan_version into previous_version from public.repository_plans
  where repository_id = version_row.repository_id and task_hash = version_row.task_hash
  for update;
  if previous_version is not null and previous_version <> input_plan_version then
    update public.repository_plan_versions set status = 'superseded',
      published_at = null, updated_at = now() where plan_version = previous_version;
  end if;
  update public.repository_plan_versions set status = 'published',
    published_at = coalesce(published_at, now()), updated_at = now()
  where plan_version = input_plan_version;
  insert into public.repository_plans(
    repository_id, task_hash, plan_version, rollback_plan_version,
    repository_revision, published_at
  ) values (
    version_row.repository_id, version_row.task_hash, input_plan_version,
    previous_version, version_row.repository_revision, now()
  ) on conflict (repository_id, task_hash) do update set
    plan_version = excluded.plan_version,
    rollback_plan_version = case
      when repository_plans.plan_version <> excluded.plan_version
      then repository_plans.plan_version else repository_plans.rollback_plan_version end,
    repository_revision = excluded.repository_revision,
    published_at = excluded.published_at;
end; $$;

create or replace function public.fail_repository_plan_version(
  input_plan_version text, input_diagnostics jsonb
)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare diagnostic jsonb;
begin
  update public.repository_plan_versions set status = 'failed', updated_at = now()
  where plan_version = input_plan_version and status in ('building','validating');
  if found then
    for diagnostic in select value from jsonb_array_elements(coalesce(input_diagnostics,'[]'))
    loop
      insert into public.repository_plan_diagnostics(plan_version, code, message, details)
      values (
        input_plan_version, coalesce(diagnostic->>'code','planner_failed'),
        coalesce(diagnostic->>'message','Repository planning failed.'), diagnostic
      );
    end loop;
  end if;
end; $$;

create or replace function public.get_published_repository_plan(
  input_repository_id text, input_task_hash text
)
returns table(
  plan_version text, task_hash text, repository_id text, repository_revision text,
  intelligence_version text, graph_version text, embedding_version text,
  planner_version text, schema_version text, status text, plan jsonb,
  publication_metadata jsonb, created_at timestamptz,
  validated_at timestamptz, published_at timestamptz
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select version.plan_version, version.task_hash, version.repository_id,
    version.repository_revision, version.intelligence_version, version.graph_version,
    version.embedding_version, version.planner_version, version.schema_version,
    version.status, version.plan, version.publication_metadata, version.created_at,
    version.validated_at, version.published_at
  from public.repository_plans plans
  join public.repository_plan_versions version on version.plan_version = plans.plan_version
  where plans.repository_id = input_repository_id and plans.task_hash = input_task_hash
    and version.status = 'published';
$$;

create or replace function public.collect_repository_plan_versions(
  input_repository_id text, input_task_hash text, input_retention_count integer
)
returns table(deleted_count integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare removed integer;
begin
  if input_retention_count < 2 then
    raise check_violation using message = 'retention must preserve rollback plan';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    input_repository_id || ':plan:' || input_task_hash || ':gc', 0
  ));
  with protected as (
    select plan_version from public.repository_plans
    where repository_id = input_repository_id and task_hash = input_task_hash
    union
    select rollback_plan_version from public.repository_plans
    where repository_id = input_repository_id and task_hash = input_task_hash
      and rollback_plan_version is not null
    union
    select plan_version from public.repository_plan_versions
    where repository_id = input_repository_id and task_hash = input_task_hash
      and status in ('building','validating')
  ), retained_history as (
    select plan_version from public.repository_plan_versions
    where repository_id = input_repository_id and task_hash = input_task_hash
      and status in ('published','superseded')
    order by published_at desc nulls last, created_at desc, plan_version
    limit input_retention_count
  ), deleted as (
    delete from public.repository_plan_versions version
    where version.repository_id = input_repository_id
      and version.task_hash = input_task_hash
      and version.status in ('failed','superseded')
      and not exists (select 1 from protected where protected.plan_version = version.plan_version)
      and not exists (
        select 1 from retained_history where retained_history.plan_version = version.plan_version
      )
    returning 1
  ) select count(*) into removed from deleted;
  return query select removed;
end; $$;

create or replace function public.recover_repository_plan_versions()
returns table(recovered_count integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
declare recovered integer;
begin
  with recovered_rows as (
    update public.repository_plan_versions set status = 'failed', updated_at = now()
    where status in ('building','validating') returning plan_version
  ), diagnostics as (
    insert into public.repository_plan_diagnostics(plan_version, code, message)
      select plan_version, 'startup_recovery', 'Interrupted repository plan.'
      from recovered_rows returning 1
  ) select count(*) into recovered from diagnostics;
  return query select recovered;
end; $$;

create or replace function public.verify_repository_planning_contract(input_planner_version text)
returns table(valid boolean)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if input_planner_version <> 'repository-planner-v1' then
    raise check_violation using message = 'repository planner version is incompatible';
  end if;
  if to_regclass('public.repository_plan_versions') is null
    or to_regclass('public.repository_plans') is null
    or to_regclass('public.repository_plan_diagnostics') is null then
    raise check_violation using message = 'repository planning tables are missing';
  end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'repository_plan_versions_repository_task_status_idx'
  ) or not exists (
    select 1 from pg_indexes where schemaname = 'public'
      and indexname = 'repository_plan_versions_cleanup_idx'
  ) then raise check_violation using message = 'repository planning indexes are missing'; end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.repository_plan_versions'::regclass
      and conname = 'repository_plan_versions_status_valid'
  ) or not exists (
    select 1 from pg_constraint where conrelid = 'public.repository_plans'::regclass
      and conname = 'repository_plans_rollback_not_current'
  ) then raise check_violation using message = 'repository planning constraints are missing'; end if;
  if exists (
    select 1 from public.repository_plans plans
    left join public.repository_plan_versions version on version.plan_version = plans.plan_version
    where version.status is distinct from 'published'
      or version.repository_id is distinct from plans.repository_id
      or version.task_hash is distinct from plans.task_hash
      or version.repository_revision is distinct from plans.repository_revision
      or version.planner_version is distinct from input_planner_version
      or version.schema_version is distinct from 'repository-plan-schema-v1'
  ) then raise check_violation using message = 'repository planning publication integrity is invalid'; end if;
  if exists (
    select 1 from pg_class relation where relation.oid in (
      'public.repository_plan_versions'::regclass,
      'public.repository_plans'::regclass,
      'public.repository_plan_diagnostics'::regclass
    ) and not relation.relrowsecurity
  ) then raise check_violation using message = 'repository planning RLS is not enabled'; end if;
  if has_table_privilege('anon','public.repository_plan_versions','select')
    or has_table_privilege('authenticated','public.repository_plan_versions','select')
    or not has_table_privilege('service_role','public.repository_plan_versions','select')
    or not has_function_privilege(
      'service_role','public.get_published_repository_plan(text,text)','execute'
    ) then raise check_violation using message = 'repository planning grants are invalid'; end if;
  return query select true;
end; $$;

alter table public.repository_plan_versions enable row level security;
alter table public.repository_plans enable row level security;
alter table public.repository_plan_diagnostics enable row level security;

revoke all on table public.repository_plan_versions, public.repository_plans,
  public.repository_plan_diagnostics from public, anon, authenticated;
grant all on table public.repository_plan_versions, public.repository_plans,
  public.repository_plan_diagnostics to service_role;
grant usage, select on sequence public.repository_plan_diagnostics_diagnostic_id_seq to service_role;

revoke all on function public.begin_repository_plan_version(text,text,text,text,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.stage_repository_plan_version(text,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated;
revoke all on function public.validate_repository_plan_version(text)
  from public, anon, authenticated;
revoke all on function public.publish_repository_plan_version(text)
  from public, anon, authenticated;
revoke all on function public.fail_repository_plan_version(text,jsonb)
  from public, anon, authenticated;
revoke all on function public.get_published_repository_plan(text,text)
  from public, anon, authenticated;
revoke all on function public.collect_repository_plan_versions(text,text,integer)
  from public, anon, authenticated;
revoke all on function public.recover_repository_plan_versions()
  from public, anon, authenticated;
revoke all on function public.verify_repository_planning_contract(text)
  from public, anon, authenticated;

grant execute on function public.begin_repository_plan_version(text,text,text,text,text,text,text,text,text)
  to service_role;
grant execute on function public.stage_repository_plan_version(text,jsonb,jsonb,jsonb,jsonb)
  to service_role;
grant execute on function public.validate_repository_plan_version(text) to service_role;
grant execute on function public.publish_repository_plan_version(text) to service_role;
grant execute on function public.fail_repository_plan_version(text,jsonb) to service_role;
grant execute on function public.get_published_repository_plan(text,text) to service_role;
grant execute on function public.collect_repository_plan_versions(text,text,integer) to service_role;
grant execute on function public.recover_repository_plan_versions() to service_role;
grant execute on function public.verify_repository_planning_contract(text) to service_role;
