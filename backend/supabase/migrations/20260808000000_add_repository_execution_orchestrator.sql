create table if not exists public.repository_execution_versions (
  execution_version text primary key,
  execution_id text not null,
  owner_user_id text not null,
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  repository_revision text not null,
  source_plan_id text not null,
  source_plan_version text not null references public.repository_plan_versions(plan_version) on delete restrict,
  orchestrator_version text not null,
  schema_version text not null,
  policy text not null,
  status text not null,
  approval_state text not null,
  execution_policy jsonb not null default '{}'::jsonb,
  user_constraints jsonb not null default '{}'::jsonb,
  run jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  constraint repository_execution_versions_identity_unique
    unique(execution_id, execution_version, owner_user_id, repository_id),
  constraint repository_execution_versions_revision_fkey
    foreign key(repository_id, repository_revision)
    references public.repository_snapshots(repository_id, revision) on delete cascade,
  constraint repository_execution_versions_status_valid check (
    status in ('queued','planning','awaiting_approval','approved','running','paused',
      'succeeded','failed','cancelled','superseded')
  ),
  constraint repository_execution_versions_policy_valid check (
    policy in ('review_only','dry_run','agent_assisted','guarded_execution')
  ),
  constraint repository_execution_versions_approval_valid check (
    approval_state in ('not_required','pending','partial','approved','rejected')
  ),
  constraint repository_execution_versions_identity_present check (
    btrim(execution_version) <> '' and btrim(execution_id) <> ''
    and btrim(owner_user_id) <> '' and btrim(repository_revision) <> ''
    and btrim(source_plan_id) <> '' and btrim(orchestrator_version) <> ''
  ),
  constraint repository_execution_versions_json_objects check (
    jsonb_typeof(execution_policy) = 'object'
    and jsonb_typeof(user_constraints) = 'object'
    and jsonb_typeof(run) = 'object'
  )
);

create table if not exists public.repository_executions (
  execution_id text primary key,
  execution_version text not null unique
    references public.repository_execution_versions(execution_version) on delete cascade,
  owner_user_id text not null,
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  source_plan_version text not null,
  repository_revision text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repository_executions_identity_fkey
    foreign key(execution_id, execution_version, owner_user_id, repository_id)
    references public.repository_execution_versions(
      execution_id, execution_version, owner_user_id, repository_id
    ) on delete cascade
);

create table if not exists public.repository_execution_work_units (
  execution_version text not null
    references public.repository_execution_versions(execution_version) on delete cascade,
  work_unit_id text not null,
  phase_id text not null,
  unit_order integer not null,
  status text not null,
  definition jsonb not null,
  attempt integer not null default 0,
  output_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(execution_version, work_unit_id),
  constraint repository_execution_work_units_status_valid check (
    status in ('blocked','ready','leased','running','awaiting_review',
      'succeeded','failed','cancelled','skipped')
  ),
  constraint repository_execution_work_units_counters_valid
    check (unit_order >= 0 and attempt >= 0 and output_version >= 0),
  constraint repository_execution_work_units_definition_object
    check (jsonb_typeof(definition) = 'object')
);

create table if not exists public.repository_execution_work_unit_dependencies (
  execution_version text not null,
  work_unit_id text not null,
  prerequisite_work_unit_id text not null,
  created_at timestamptz not null default now(),
  primary key(execution_version, work_unit_id, prerequisite_work_unit_id),
  foreign key(execution_version, work_unit_id)
    references public.repository_execution_work_units(execution_version, work_unit_id) on delete cascade,
  foreign key(execution_version, prerequisite_work_unit_id)
    references public.repository_execution_work_units(execution_version, work_unit_id) on delete cascade,
  constraint repository_execution_dependency_not_self
    check (work_unit_id <> prerequisite_work_unit_id)
);

create table if not exists public.repository_execution_approvals (
  approval_id text primary key,
  execution_version text not null
    references public.repository_execution_versions(execution_version) on delete cascade,
  owner_user_id text not null,
  scope text not null,
  work_unit_ids jsonb not null default '[]'::jsonb,
  decision text not null,
  repository_revision text not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique(execution_version, idempotency_key),
  constraint repository_execution_approvals_scope_valid check (scope in ('run','work_units')),
  constraint repository_execution_approvals_decision_valid check (decision in ('approved','rejected')),
  constraint repository_execution_approvals_units_array check (jsonb_typeof(work_unit_ids) = 'array')
);

create table if not exists public.repository_execution_work_unit_leases (
  execution_version text not null,
  work_unit_id text not null,
  owner_user_id text not null,
  repository_id text not null,
  worker_id text not null,
  claim_token text not null unique,
  attempt integer not null,
  claimed_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  primary key(execution_version, work_unit_id),
  foreign key(execution_version, work_unit_id)
    references public.repository_execution_work_units(execution_version, work_unit_id) on delete cascade,
  constraint repository_execution_leases_present check (
    btrim(owner_user_id) <> '' and btrim(repository_id) <> ''
    and btrim(worker_id) <> '' and btrim(claim_token) <> '' and attempt > 0
  ),
  constraint repository_execution_leases_expiry check (lease_expires_at > claimed_at)
);

create table if not exists public.repository_execution_agent_outputs (
  execution_version text not null,
  work_unit_id text not null,
  output_version integer not null,
  attempt integer not null,
  worker_id text not null,
  payload_hash text not null,
  output jsonb not null,
  created_at timestamptz not null default now(),
  primary key(execution_version, work_unit_id, output_version),
  foreign key(execution_version, work_unit_id)
    references public.repository_execution_work_units(execution_version, work_unit_id) on delete cascade,
  constraint repository_execution_outputs_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint repository_execution_outputs_structured check (
    jsonb_typeof(output) = 'object'
    and output ?& array['summary','filesConsidered','proposedChanges','commandsProposed',
      'testsProposed','risksDiscovered','blockers','artifacts','completionStatus']
  )
);

create table if not exists public.repository_execution_reviews (
  review_id text primary key,
  execution_version text not null,
  work_unit_id text not null,
  reviewer_id text not null,
  reviewer_type text not null,
  verdict text not null,
  findings jsonb not null default '[]'::jsonb,
  required_corrections jsonb not null default '[]'::jsonb,
  reviewed_output_version integer not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique(execution_version, work_unit_id, idempotency_key),
  foreign key(execution_version, work_unit_id, reviewed_output_version)
    references public.repository_execution_agent_outputs(
      execution_version, work_unit_id, output_version
    ) on delete restrict,
  constraint repository_execution_reviews_type_valid check (reviewer_type in ('human','agent','system')),
  constraint repository_execution_reviews_verdict_valid
    check (verdict in ('approved','changes_requested','rejected','skipped')),
  constraint repository_execution_reviews_arrays check (
    jsonb_typeof(findings) = 'array' and jsonb_typeof(required_corrections) = 'array'
  )
);

create table if not exists public.repository_execution_idempotency (
  owner_user_id text not null,
  repository_id text not null,
  operation text not null,
  idempotency_key text not null,
  payload_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(owner_user_id, repository_id, operation, idempotency_key),
  constraint repository_execution_idempotency_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint repository_execution_idempotency_response_object check (jsonb_typeof(response) = 'object')
);

create table if not exists public.repository_execution_diagnostics (
  diagnostic_id bigint generated always as identity primary key,
  execution_version text not null
    references public.repository_execution_versions(execution_version) on delete cascade,
  work_unit_id text,
  code text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint repository_execution_diagnostics_present check (btrim(code) <> '' and btrim(message) <> ''),
  constraint repository_execution_diagnostics_details_object check (jsonb_typeof(details) = 'object')
);

create index if not exists repository_execution_versions_owner_repository_idx
  on public.repository_execution_versions(owner_user_id, repository_id, created_at desc, execution_id);
create index if not exists repository_execution_versions_status_idx
  on public.repository_execution_versions(owner_user_id, status, updated_at)
  where status not in ('succeeded','failed','cancelled','superseded');
create index if not exists repository_execution_work_units_status_idx
  on public.repository_execution_work_units(execution_version, status, unit_order);
create index if not exists repository_execution_work_unit_dependencies_prerequisite_idx
  on public.repository_execution_work_unit_dependencies(execution_version, prerequisite_work_unit_id);
create index if not exists repository_execution_leases_claim_idx
  on public.repository_execution_work_unit_leases(owner_user_id, claim_token, lease_expires_at);
create index if not exists repository_execution_leases_expiry_idx
  on public.repository_execution_work_unit_leases(lease_expires_at, execution_version, work_unit_id);
create index if not exists repository_execution_outputs_worker_idx
  on public.repository_execution_agent_outputs(execution_version, work_unit_id, worker_id, created_at);
create index if not exists repository_execution_reviews_output_idx
  on public.repository_execution_reviews(execution_version, work_unit_id, reviewed_output_version);
create index if not exists repository_execution_diagnostics_version_idx
  on public.repository_execution_diagnostics(execution_version, created_at);
create index if not exists repository_execution_idempotency_created_idx
  on public.repository_execution_idempotency(created_at);

create or replace function public.execution_payload_hash(input_payload jsonb)
returns text language sql immutable parallel safe as $$
  select md5(input_payload::text) || md5('repository-execution:' || input_payload::text)
$$;

create or replace function public.refresh_repository_execution(input_execution_version text)
returns void language plpgsql security invoker set search_path = public as $$
declare next_status text;
begin
  update public.repository_execution_work_units unit set
    status = case
      when exists (
        select 1 from public.repository_execution_work_unit_dependencies dependency
        join public.repository_execution_work_units predecessor
          on predecessor.execution_version = dependency.execution_version
          and predecessor.work_unit_id = dependency.prerequisite_work_unit_id
        where dependency.execution_version = unit.execution_version
          and dependency.work_unit_id = unit.work_unit_id
          and predecessor.status in ('failed','cancelled')
      ) then 'blocked'
      when not exists (
        select 1 from public.repository_execution_work_unit_dependencies dependency
        join public.repository_execution_work_units predecessor
          on predecessor.execution_version = dependency.execution_version
          and predecessor.work_unit_id = dependency.prerequisite_work_unit_id
        where dependency.execution_version = unit.execution_version
          and dependency.work_unit_id = unit.work_unit_id
          and predecessor.status not in ('succeeded','skipped')
      ) then 'ready'
      else 'blocked'
    end,
    updated_at = now()
  where unit.execution_version = input_execution_version and unit.status in ('blocked','ready');

  select case
    when bool_or(status = 'failed') then 'failed'
    when bool_and(status in ('succeeded','skipped')) then 'succeeded'
    when bool_or(status in ('leased','running','awaiting_review')) then 'running'
    else null
  end into next_status
  from public.repository_execution_work_units where execution_version = input_execution_version;
  if next_status is not null then
    update public.repository_execution_versions set
      status = next_status, updated_at = now(),
      completed_at = case when next_status in ('failed','succeeded') then now() else completed_at end,
      run = jsonb_set(jsonb_set(run, '{status}', to_jsonb(next_status)), '{updatedAt}', to_jsonb(now()::text))
    where execution_version = input_execution_version
      and status not in ('cancelled','superseded');
    update public.repository_executions execution set status = next_status, updated_at = now()
    where execution.execution_version = input_execution_version;
  end if;
end; $$;

create or replace function public.repository_execution_run_json(input_execution_version text)
returns jsonb language sql stable security invoker set search_path=public as $$
  select version.run || jsonb_build_object(
    'status',version.status,
    'approvalState',version.approval_state,
    'updatedAt',version.updated_at::text,
    'approvedAt',version.approved_at,
    'startedAt',version.started_at,
    'completedAt',version.completed_at,
    'workUnits',coalesce((
      select jsonb_agg(unit.definition || jsonb_build_object(
        'status',unit.status,'attempt',unit.attempt,'outputVersion',unit.output_version,
        'createdAt',unit.created_at::text,'updatedAt',unit.updated_at::text
      ) order by unit.unit_order,unit.work_unit_id)
      from public.repository_execution_work_units unit
      where unit.execution_version=version.execution_version
    ),'[]'),
    'approvals',coalesce((
      select jsonb_agg(jsonb_build_object(
        'approvalId',approval.approval_id,'scope',approval.scope,
        'workUnitIds',approval.work_unit_ids,'decision',approval.decision,
        'ownerId',approval.owner_user_id,'executionVersion',approval.execution_version,
        'repositoryRevision',approval.repository_revision,
        'idempotencyKey',approval.idempotency_key,'createdAt',approval.created_at::text
      ) order by approval.created_at,approval.approval_id)
      from public.repository_execution_approvals approval
      where approval.execution_version=version.execution_version
    ),'[]'),
    'leases',coalesce((
      select jsonb_agg(jsonb_build_object(
        'workUnitId',lease.work_unit_id,'workerId',lease.worker_id,
        'claimToken',lease.claim_token,'attempt',lease.attempt,
        'claimedAt',lease.claimed_at::text,'heartbeatAt',lease.heartbeat_at::text,
        'leaseExpiresAt',lease.lease_expires_at::text
      ) order by lease.work_unit_id)
      from public.repository_execution_work_unit_leases lease
      where lease.execution_version=version.execution_version
    ),'[]'),
    'outputs',coalesce((
      select jsonb_agg(jsonb_build_object(
        'workUnitId',output.work_unit_id,'outputVersion',output.output_version,
        'attempt',output.attempt,'workerId',output.worker_id,
        'payloadHash',output.payload_hash,'output',output.output,'createdAt',output.created_at::text
      ) order by output.work_unit_id,output.output_version)
      from public.repository_execution_agent_outputs output
      where output.execution_version=version.execution_version
    ),'[]'),
    'reviews',coalesce((
      select jsonb_agg(jsonb_build_object(
        'reviewId',review.review_id,'workUnitId',review.work_unit_id,
        'reviewerId',review.reviewer_id,'reviewerType',review.reviewer_type,
        'verdict',review.verdict,'findings',review.findings,
        'requiredCorrections',review.required_corrections,
        'reviewedOutputVersion',review.reviewed_output_version,
        'idempotencyKey',review.idempotency_key,'createdAt',review.created_at::text
      ) order by review.created_at,review.review_id)
      from public.repository_execution_reviews review
      where review.execution_version=version.execution_version
    ),'[]'),
    'diagnostics',coalesce((
      select jsonb_agg(jsonb_build_object(
        'code',diagnostic.code,'message',diagnostic.message,
        'workUnitId',diagnostic.work_unit_id,'details',diagnostic.details,
        'createdAt',diagnostic.created_at::text
      ) order by diagnostic.created_at,diagnostic.diagnostic_id)
      from public.repository_execution_diagnostics diagnostic
      where diagnostic.execution_version=version.execution_version
    ),'[]')
  )
  from public.repository_execution_versions version
  where version.execution_version=input_execution_version
$$;

create or replace function public.create_repository_execution(
  input_run jsonb, input_idempotency_key text, input_max_active_runs integer
) returns table(run jsonb)
language plpgsql security invoker set search_path = public as $$
declare payload_hash text := public.execution_payload_hash(input_run);
declare stored public.repository_execution_idempotency%rowtype;
declare plan_row public.repository_plan_versions%rowtype;
declare repository_row public.repositories%rowtype;
declare unit jsonb;
begin
  select * into stored from public.repository_execution_idempotency record
  where record.owner_user_id = input_run->>'ownerId'
    and record.repository_id = input_run->>'repositoryId'
    and record.operation = 'create'
    and record.idempotency_key = input_idempotency_key;
  if found then
    if stored.payload_hash <> payload_hash then
      raise unique_violation using message = 'execution_idempotency_conflict';
    end if;
    return query select stored.response->'run';
    return;
  end if;
  select * into repository_row from public.repositories repository
    where repository.repository_id = input_run->>'repositoryId' for share;
  if not found then raise foreign_key_violation using message = 'repository_deleted'; end if;
  if repository_row.owner_user_id is distinct from input_run->>'ownerId' then
    raise insufficient_privilege using message = 'execution_owner_mismatch';
  end if;
  select * into plan_row from public.repository_plan_versions plan
    where plan.plan_version = input_run->>'sourcePlanVersion' for share;
  if not found or plan_row.status <> 'published' then
    raise check_violation using message = 'plan_unpublished';
  end if;
  if plan_row.repository_id <> input_run->>'repositoryId'
    or plan_row.repository_revision <> input_run->>'repositoryRevision' then
    raise check_violation using message = 'stale_repository_revision';
  end if;
  if (
    select count(*) from public.repository_execution_versions version
    where version.owner_user_id = input_run->>'ownerId'
      and version.status not in ('succeeded','failed','cancelled','superseded')
  ) >= input_max_active_runs then
    raise program_limit_exceeded using message = 'execution_active_run_quota_exceeded';
  end if;
  insert into public.repository_execution_versions(
    execution_version, execution_id, owner_user_id, repository_id, repository_revision,
    source_plan_id, source_plan_version, orchestrator_version, schema_version,
    policy, status, approval_state, execution_policy, user_constraints, run
  ) values (
    input_run->>'executionVersion', input_run->>'executionId', input_run->>'ownerId',
    input_run->>'repositoryId', input_run->>'repositoryRevision',
    input_run->>'sourcePlanId', input_run->>'sourcePlanVersion',
    input_run->>'orchestratorVersion', input_run->>'schemaVersion',
    input_run->>'policy', input_run->>'status', input_run->>'approvalState',
    jsonb_build_object('policy', input_run->>'policy'),
    coalesce(input_run->'userConstraints','{}'), input_run
  );
  insert into public.repository_executions(
    execution_id, execution_version, owner_user_id, repository_id,
    source_plan_version, repository_revision, status
  ) values (
    input_run->>'executionId', input_run->>'executionVersion', input_run->>'ownerId',
    input_run->>'repositoryId', input_run->>'sourcePlanVersion',
    input_run->>'repositoryRevision', input_run->>'status'
  );
  for unit in select value from jsonb_array_elements(input_run->'workUnits') loop
    insert into public.repository_execution_work_units(
      execution_version, work_unit_id, phase_id, unit_order, status,
      definition, attempt, output_version
    ) values (
      input_run->>'executionVersion', unit->>'workUnitId', unit->>'phaseId',
      (unit->>'order')::integer, unit->>'status', unit,
      coalesce((unit->>'attempt')::integer,0), coalesce((unit->>'outputVersion')::integer,0)
    );
  end loop;
  for unit in select value from jsonb_array_elements(input_run->'workUnits') loop
    insert into public.repository_execution_work_unit_dependencies(
      execution_version, work_unit_id, prerequisite_work_unit_id
    ) select input_run->>'executionVersion', unit->>'workUnitId', value
      from jsonb_array_elements_text(coalesce(unit->'prerequisites','[]'));
  end loop;
  insert into public.repository_execution_idempotency(
    owner_user_id, repository_id, operation, idempotency_key, payload_hash, response
  ) values (
    input_run->>'ownerId', input_run->>'repositoryId', 'create',
    input_idempotency_key, payload_hash, jsonb_build_object('run', input_run)
  );
  return query select input_run;
end; $$;

create or replace function public.get_repository_execution(
  input_owner_id text, input_repository_id text, input_execution_id text
) returns table(run jsonb)
language sql stable security invoker set search_path = public as $$
  select public.repository_execution_run_json(version.execution_version)
  from public.repository_executions execution
  join public.repository_execution_versions version
    on version.execution_version = execution.execution_version
  where execution.owner_user_id = input_owner_id
    and execution.repository_id = input_repository_id
    and execution.execution_id = input_execution_id
$$;

create or replace function public.list_repository_executions(
  input_owner_id text, input_repository_id text, input_cursor text, input_limit integer
) returns table(runs jsonb, next_cursor text)
language sql stable security invoker set search_path = public as $$
  with page as (
    select public.repository_execution_run_json(version.execution_version) as run,
      version.created_at, version.execution_id
    from public.repository_execution_versions version
    where version.owner_user_id = input_owner_id
      and version.repository_id = input_repository_id
      and (coalesce(input_cursor,'') = ''
        or version.created_at::text || '|' || version.execution_id < input_cursor)
    order by version.created_at desc, version.execution_id desc
    limit greatest(1, least(100, input_limit))
  )
  select coalesce(jsonb_agg(page.run order by page.created_at desc, page.execution_id desc),'[]'),
    case when count(*) = greatest(1, least(100, input_limit))
      then min(page.created_at::text || '|' || page.execution_id) else null end
  from page
$$;

create or replace function public.decide_repository_execution(
  input_owner_id text, input_repository_id text, input_execution_id text,
  input_execution_version text, input_repository_revision text,
  input_idempotency_key text, input_work_unit_ids jsonb, input_decision text
) returns table(run jsonb)
language plpgsql security invoker set search_path = public as $$
declare version_row public.repository_execution_versions%rowtype;
declare approval_id text;
declare units jsonb;
declare existing_approval public.repository_execution_approvals%rowtype;
declare all_approved boolean;
begin
  select * into version_row from public.repository_execution_versions version
  where version.owner_user_id = input_owner_id and version.repository_id = input_repository_id
    and version.execution_id = input_execution_id for update;
  if not found then raise no_data_found using message = 'execution_not_found'; end if;
  if version_row.execution_version <> input_execution_version
    or version_row.repository_revision <> input_repository_revision then
    raise check_violation using message = 'execution_approval_fence_rejected';
  end if;
  units := coalesce(input_work_unit_ids, (
    select coalesce(jsonb_agg(work_unit_id order by work_unit_id),'[]')
    from public.repository_execution_work_units
    where execution_version = input_execution_version
  ));
  approval_id := 'approval_' || substr(public.execution_payload_hash(jsonb_build_object(
    'version',input_execution_version,'decision',input_decision,'units',units,'key',input_idempotency_key
  )),1,24);
  select * into existing_approval from public.repository_execution_approvals approval
    where approval.execution_version=input_execution_version
      and approval.idempotency_key=input_idempotency_key;
  if found then
    if existing_approval.decision<>input_decision
      or existing_approval.repository_revision<>input_repository_revision
      or existing_approval.work_unit_ids<>units then
      raise unique_violation using message='execution_idempotency_conflict';
    end if;
    return query select public.repository_execution_run_json(input_execution_version);
    return;
  end if;
  insert into public.repository_execution_approvals(
    approval_id, execution_version, owner_user_id, scope, work_unit_ids,
    decision, repository_revision, idempotency_key
  ) values (
    approval_id, input_execution_version, input_owner_id,
    case when input_work_unit_ids is null then 'run' else 'work_units' end,
    units, input_decision, input_repository_revision, input_idempotency_key
  ) on conflict(execution_version,idempotency_key) do nothing;
  if input_decision = 'rejected' then
    update public.repository_execution_work_units set status = 'cancelled', updated_at = now()
      where execution_version = input_execution_version
        and status not in ('succeeded','failed','cancelled','skipped');
    delete from public.repository_execution_work_unit_leases where execution_version = input_execution_version;
    update public.repository_execution_versions set status='cancelled', approval_state='rejected',
      completed_at=now(), updated_at=now(),
      run=jsonb_set(jsonb_set(run,'{status}','"cancelled"'),'{approvalState}','"rejected"')
      where execution_version=input_execution_version returning repository_execution_versions.run into version_row.run;
  else
    select not exists(
      select 1 from public.repository_execution_work_units unit
      where unit.execution_version=input_execution_version
        and not exists(
          select 1 from public.repository_execution_approvals approval,
            jsonb_array_elements_text(approval.work_unit_ids) approved(value)
          where approval.execution_version=input_execution_version
            and approval.decision='approved' and approved.value=unit.work_unit_id
        )
    ) into all_approved;
    update public.repository_execution_versions set status='approved',
      approval_state=case when all_approved then 'approved' else 'partial' end,
      approved_at=coalesce(approved_at,now()), updated_at=now(),
      run=jsonb_set(jsonb_set(run,'{status}','"approved"'),'{approvalState}',
        to_jsonb(case when all_approved then 'approved' else 'partial' end))
      where execution_version=input_execution_version returning repository_execution_versions.run into version_row.run;
  end if;
  update public.repository_executions set status = version_row.run->>'status', updated_at=now()
    where execution_version=input_execution_version;
  return query select public.repository_execution_run_json(input_execution_version);
end; $$;

create or replace function public.approve_repository_execution(
  input_owner_id text, input_repository_id text, input_execution_id text,
  input_execution_version text, input_repository_revision text,
  input_idempotency_key text, input_work_unit_ids jsonb
) returns table(run jsonb) language sql security invoker set search_path=public as $$
  select * from public.decide_repository_execution(
    input_owner_id,input_repository_id,input_execution_id,input_execution_version,
    input_repository_revision,input_idempotency_key,input_work_unit_ids,'approved')
$$;

create or replace function public.reject_repository_execution(
  input_owner_id text, input_repository_id text, input_execution_id text,
  input_execution_version text, input_repository_revision text,
  input_idempotency_key text, input_work_unit_ids jsonb
) returns table(run jsonb) language sql security invoker set search_path=public as $$
  select * from public.decide_repository_execution(
    input_owner_id,input_repository_id,input_execution_id,input_execution_version,
    input_repository_revision,input_idempotency_key,input_work_unit_ids,'rejected')
$$;

create or replace function public.lease_repository_execution_work_unit(
  input_owner_id text, input_repository_id text, input_execution_id text,
  input_worker_id text, input_lease_ms integer, input_max_concurrent_leases integer
) returns table(
  work_unit_id text, worker_id text, claim_token text, attempt integer,
  claimed_at timestamptz, heartbeat_at timestamptz, lease_expires_at timestamptz
) language plpgsql security invoker set search_path=public as $$
declare version_id text;
declare unit_id text;
begin
  if (select count(*) from public.repository_execution_work_unit_leases
      where owner_user_id=input_owner_id and lease_expires_at>now()) >= input_max_concurrent_leases then
    raise program_limit_exceeded using message='execution_lease_quota_exceeded';
  end if;
  select execution.execution_version into version_id from public.repository_executions execution
    join public.repository_execution_versions version using(execution_version)
    where execution.owner_user_id=input_owner_id and execution.repository_id=input_repository_id
      and execution.execution_id=input_execution_id and version.status in ('approved','running')
      and version.approval_state='approved'
      and version.policy in ('agent_assisted','guarded_execution') for update of version;
  if version_id is null then raise check_violation using message='execution_approval_required'; end if;
  select unit.work_unit_id into unit_id from public.repository_execution_work_units unit
    where unit.execution_version=version_id and unit.status='ready'
      and exists(
        select 1 from public.repository_execution_approvals approval,
          jsonb_array_elements_text(approval.work_unit_ids) approved(value)
        where approval.execution_version=version_id and approval.decision='approved'
          and approved.value=unit.work_unit_id
      )
    order by unit.unit_order,unit.work_unit_id for update skip locked limit 1;
  if unit_id is null then return; end if;
  update public.repository_execution_work_units set status='leased',attempt=attempt+1,updated_at=now()
    where execution_version=version_id and repository_execution_work_units.work_unit_id=unit_id;
  insert into public.repository_execution_work_unit_leases(
    execution_version,work_unit_id,owner_user_id,repository_id,worker_id,
    claim_token,attempt,lease_expires_at
  ) select version_id,unit_id,input_owner_id,input_repository_id,input_worker_id,
    gen_random_uuid()::text,unit.attempt,
    now()+make_interval(secs=>input_lease_ms::double precision/1000)
    from public.repository_execution_work_units unit
    where unit.execution_version=version_id and unit.work_unit_id=unit_id;
  update public.repository_execution_versions set status='running',started_at=coalesce(started_at,now()),updated_at=now()
    where execution_version=version_id;
  update public.repository_executions set status='running',updated_at=now() where execution_version=version_id;
  return query select lease.work_unit_id,lease.worker_id,lease.claim_token,lease.attempt,
    lease.claimed_at,lease.heartbeat_at,lease.lease_expires_at
    from public.repository_execution_work_unit_leases lease
    where lease.execution_version=version_id and lease.work_unit_id=unit_id;
end; $$;

create or replace function public.heartbeat_repository_execution_work_unit(
  input_owner_id text,input_repository_id text,input_execution_id text,input_work_unit_id text,
  input_worker_id text,input_claim_token text,input_lease_ms integer
) returns setof public.repository_execution_work_unit_leases
language plpgsql security invoker set search_path=public as $$
begin
  return query update public.repository_execution_work_unit_leases lease set
    heartbeat_at=now(),lease_expires_at=now()+make_interval(secs=>input_lease_ms::double precision/1000)
  from public.repository_executions execution
  where execution.execution_version=lease.execution_version
    and execution.owner_user_id=input_owner_id and execution.repository_id=input_repository_id
    and execution.execution_id=input_execution_id and lease.work_unit_id=input_work_unit_id
    and lease.worker_id=input_worker_id and lease.claim_token=input_claim_token
    and lease.lease_expires_at>now()
  returning lease.*;
  if not found then raise check_violation using message='execution_claim_fence_rejected'; end if;
  update public.repository_execution_work_units set status='running',updated_at=now()
    where work_unit_id=input_work_unit_id and execution_version=(
      select execution_version from public.repository_executions where execution_id=input_execution_id
    );
end; $$;

create or replace function public.publish_repository_execution_output(
  input_owner_id text,input_repository_id text,input_execution_id text,input_work_unit_id text,
  input_worker_id text,input_claim_token text,input_output jsonb,
  input_idempotency_key text,input_max_output_bytes integer
) returns table(output_version integer)
language plpgsql security invoker set search_path=public as $$
declare lease_row public.repository_execution_work_unit_leases%rowtype;
declare next_version integer;
declare version_id text;
declare idempotency_record public.repository_execution_idempotency%rowtype;
declare output_hash text:=public.execution_payload_hash(input_output);
declare operation_name text:='output:'||input_execution_id||':'||input_work_unit_id;
begin
  if pg_column_size(input_output)>input_max_output_bytes or not (
    input_output ?& array['summary','filesConsidered','proposedChanges','commandsProposed',
      'testsProposed','risksDiscovered','blockers','artifacts','completionStatus']
  ) then raise check_violation using message='invalid_agent_output'; end if;
  select * into idempotency_record from public.repository_execution_idempotency record
    where record.owner_user_id=input_owner_id and record.repository_id=input_repository_id
      and record.operation=operation_name and record.idempotency_key=input_idempotency_key;
  if found then
    if idempotency_record.payload_hash<>output_hash then
      raise unique_violation using message='execution_idempotency_conflict';
    end if;
    return query select (idempotency_record.response->>'outputVersion')::integer;
    return;
  end if;
  select lease.* into lease_row from public.repository_execution_work_unit_leases lease
    join public.repository_executions execution using(execution_version)
    where execution.owner_user_id=input_owner_id and execution.repository_id=input_repository_id
      and execution.execution_id=input_execution_id and lease.work_unit_id=input_work_unit_id
      and lease.worker_id=input_worker_id and lease.claim_token=input_claim_token
      and lease.lease_expires_at>now() for update of lease;
  if not found then raise check_violation using message='execution_claim_fence_rejected'; end if;
  version_id:=lease_row.execution_version;
  select unit.output_version+1 into next_version from public.repository_execution_work_units unit
    where unit.execution_version=version_id and unit.work_unit_id=input_work_unit_id for update;
  insert into public.repository_execution_agent_outputs(
    execution_version,work_unit_id,output_version,attempt,worker_id,payload_hash,output
  ) values(version_id,input_work_unit_id,next_version,lease_row.attempt,input_worker_id,
    output_hash,input_output);
  update public.repository_execution_work_units set output_version=next_version,status='awaiting_review',updated_at=now()
    where execution_version=version_id and work_unit_id=input_work_unit_id;
  delete from public.repository_execution_work_unit_leases
    where execution_version=version_id and work_unit_id=input_work_unit_id and claim_token=input_claim_token;
  perform public.refresh_repository_execution(version_id);
  insert into public.repository_execution_idempotency(
    owner_user_id,repository_id,operation,idempotency_key,payload_hash,response
  ) values(input_owner_id,input_repository_id,operation_name,input_idempotency_key,output_hash,
    jsonb_build_object('outputVersion',next_version));
  return query select next_version;
end; $$;

create or replace function public.submit_repository_execution_review(
  input_owner_id text,input_repository_id text,input_execution_id text,input_work_unit_id text,
  input_reviewer_id text,input_reviewer_type text,input_verdict text,input_findings jsonb,
  input_required_corrections jsonb,input_reviewed_output_version integer,input_idempotency_key text
) returns table(review jsonb)
language plpgsql security invoker set search_path=public as $$
declare version_id text;
declare current_output integer;
declare review_id text;
declare idempotency_record public.repository_execution_idempotency%rowtype;
declare review_payload jsonb;
declare review_hash text;
declare operation_name text:='review:'||input_execution_id||':'||input_work_unit_id;
begin
  review_payload:=jsonb_build_object(
    'reviewerId',input_reviewer_id,'reviewerType',input_reviewer_type,'verdict',input_verdict,
    'findings',input_findings,'requiredCorrections',input_required_corrections,
    'reviewedOutputVersion',input_reviewed_output_version
  );
  review_hash:=public.execution_payload_hash(review_payload);
  select * into idempotency_record from public.repository_execution_idempotency record
    where record.owner_user_id=input_owner_id and record.repository_id=input_repository_id
      and record.operation=operation_name and record.idempotency_key=input_idempotency_key;
  if found then
    if idempotency_record.payload_hash<>review_hash then
      raise unique_violation using message='execution_idempotency_conflict';
    end if;
    return query select idempotency_record.response->'review';
    return;
  end if;
  select execution.execution_version into version_id from public.repository_executions execution
    where execution.owner_user_id=input_owner_id and execution.repository_id=input_repository_id
      and execution.execution_id=input_execution_id;
  select unit.output_version into current_output from public.repository_execution_work_units unit
    where unit.execution_version=version_id and unit.work_unit_id=input_work_unit_id
      and unit.status='awaiting_review' for update;
  if current_output is null or current_output<>input_reviewed_output_version then
    raise check_violation using message='stale_output_review';
  end if;
  review_id:='review_'||substr(public.execution_payload_hash(jsonb_build_object(
    'version',version_id,'unit',input_work_unit_id,'key',input_idempotency_key)),1,24);
  insert into public.repository_execution_reviews(
    review_id,execution_version,work_unit_id,reviewer_id,reviewer_type,verdict,
    findings,required_corrections,reviewed_output_version,idempotency_key
  ) values(review_id,version_id,input_work_unit_id,input_reviewer_id,input_reviewer_type,input_verdict,
    input_findings,input_required_corrections,input_reviewed_output_version,input_idempotency_key)
    on conflict(execution_version,work_unit_id,idempotency_key) do nothing;
  update public.repository_execution_work_units set
    status=case input_verdict when 'approved' then 'succeeded' when 'skipped' then 'skipped'
      when 'changes_requested' then 'ready' else 'failed' end,updated_at=now()
    where execution_version=version_id and work_unit_id=input_work_unit_id;
  perform public.refresh_repository_execution(version_id);
  review_payload:=jsonb_build_object(
    'reviewId',review_id,'workUnitId',input_work_unit_id,'reviewerId',input_reviewer_id,
    'reviewerType',input_reviewer_type,'verdict',input_verdict,'findings',input_findings,
    'requiredCorrections',input_required_corrections,
    'reviewedOutputVersion',input_reviewed_output_version,'idempotencyKey',input_idempotency_key
  );
  insert into public.repository_execution_idempotency(
    owner_user_id,repository_id,operation,idempotency_key,payload_hash,response
  ) values(input_owner_id,input_repository_id,operation_name,input_idempotency_key,review_hash,
    jsonb_build_object('review',review_payload));
  return query select review_payload;
end; $$;

create or replace function public.fail_repository_execution_work_unit(
  input_owner_id text,input_repository_id text,input_execution_id text,input_work_unit_id text,
  input_worker_id text,input_claim_token text,input_code text,input_message text,input_retryable boolean
) returns void language plpgsql security invoker set search_path=public as $$
declare lease_row public.repository_execution_work_unit_leases%rowtype;
begin
  select lease.* into lease_row from public.repository_execution_work_unit_leases lease
    join public.repository_executions execution using(execution_version)
    where execution.owner_user_id=input_owner_id and execution.repository_id=input_repository_id
      and execution.execution_id=input_execution_id and lease.work_unit_id=input_work_unit_id
      and lease.worker_id=input_worker_id and lease.claim_token=input_claim_token
      and lease.lease_expires_at>now() for update of lease;
  if not found then raise check_violation using message='execution_claim_fence_rejected'; end if;
  update public.repository_execution_work_units unit set
    status=case when input_retryable and unit.attempt <
      coalesce((unit.definition->'retryPolicy'->>'maxAttempts')::integer,1) then 'ready' else 'failed' end,
    updated_at=now()
    where unit.execution_version=lease_row.execution_version and unit.work_unit_id=input_work_unit_id;
  delete from public.repository_execution_work_unit_leases
    where execution_version=lease_row.execution_version and work_unit_id=input_work_unit_id;
  insert into public.repository_execution_diagnostics(execution_version,work_unit_id,code,message)
    values(lease_row.execution_version,input_work_unit_id,input_code,input_message);
  perform public.refresh_repository_execution(lease_row.execution_version);
end; $$;

create or replace function public.cancel_repository_execution(
  input_owner_id text,input_repository_id text,input_execution_id text,input_idempotency_key text
) returns table(run jsonb)
language plpgsql security invoker set search_path=public as $$
declare version_id text;
declare result jsonb;
begin
  select execution_version into version_id from public.repository_executions
    where owner_user_id=input_owner_id and repository_id=input_repository_id
      and execution_id=input_execution_id for update;
  if version_id is null then raise no_data_found using message='execution_not_found'; end if;
  delete from public.repository_execution_work_unit_leases where execution_version=version_id;
  update public.repository_execution_work_units set status='cancelled',updated_at=now()
    where execution_version=version_id and status not in ('succeeded','failed','cancelled','skipped');
  update public.repository_execution_versions set status='cancelled',completed_at=now(),updated_at=now(),
    run=jsonb_set(run,'{status}','"cancelled"') where execution_version=version_id returning repository_execution_versions.run into result;
  update public.repository_executions set status='cancelled',updated_at=now() where execution_version=version_id;
  return query select public.repository_execution_run_json(version_id);
end; $$;

create or replace function public.supersede_repository_execution(
  input_owner_id text,input_repository_id text,input_execution_id text,input_reason text
) returns void language plpgsql security invoker set search_path=public as $$
declare version_id text;
begin
  select execution_version into version_id from public.repository_executions
    where owner_user_id=input_owner_id and repository_id=input_repository_id and execution_id=input_execution_id for update;
  if version_id is null then raise no_data_found using message='execution_not_found'; end if;
  delete from public.repository_execution_work_unit_leases where execution_version=version_id;
  update public.repository_execution_work_units set status='cancelled',updated_at=now()
    where execution_version=version_id and status not in ('succeeded','failed','cancelled','skipped');
  update public.repository_execution_versions set status='superseded',completed_at=now(),updated_at=now(),
    run=jsonb_set(run,'{status}','"superseded"') where execution_version=version_id;
  update public.repository_executions set status='superseded',updated_at=now() where execution_version=version_id;
  insert into public.repository_execution_diagnostics(execution_version,code,message)
    values(version_id,'execution_superseded',input_reason);
end; $$;

create or replace function public.recover_repository_execution_leases(input_expired_before timestamptz)
returns table(recovered_count integer)
language plpgsql security invoker set search_path=public as $$
declare recovered integer:=0;
declare stale record;
begin
  for stale in select * from public.repository_execution_work_unit_leases
    where lease_expires_at<=input_expired_before order by lease_expires_at,claim_token for update skip locked
  loop
    update public.repository_execution_work_units unit set
      status=case when unit.attempt <
        coalesce((unit.definition->'retryPolicy'->>'maxAttempts')::integer,1) then 'ready' else 'failed' end,
      updated_at=now()
      where unit.execution_version=stale.execution_version and unit.work_unit_id=stale.work_unit_id;
    delete from public.repository_execution_work_unit_leases
      where execution_version=stale.execution_version and work_unit_id=stale.work_unit_id
        and claim_token=stale.claim_token;
    insert into public.repository_execution_diagnostics(execution_version,work_unit_id,code,message)
      values(stale.execution_version,stale.work_unit_id,'stale_lease_recovered','Expired lease recovered.');
    perform public.refresh_repository_execution(stale.execution_version);
    recovered:=recovered+1;
  end loop;
  return query select recovered;
end; $$;

create or replace function public.collect_repository_executions(
  input_owner_id text,input_repository_id text,input_retained_runs integer
) returns table(deleted_count integer)
language plpgsql security invoker set search_path=public as $$
declare removed integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(input_owner_id||'|'||input_repository_id,0));
  with victims as (
    select execution_version from public.repository_execution_versions
    where owner_user_id=input_owner_id and repository_id=input_repository_id
      and status in ('succeeded','failed','cancelled','superseded')
    order by created_at desc,execution_version desc
    offset greatest(1,input_retained_runs)
  )
  delete from public.repository_execution_versions version
    using victims where version.execution_version=victims.execution_version;
  get diagnostics removed=row_count;
  return query select removed;
end; $$;

create or replace function public.verify_repository_execution_contract(
  input_orchestrator_version text,input_guarded_execution_enabled boolean,input_retained_runs integer
) returns table(valid boolean,problems jsonb)
language plpgsql stable security invoker set search_path=public as $$
declare issues jsonb:='[]'::jsonb;
begin
  if input_orchestrator_version<>'repository-execution-v1' then
    issues:=issues||'"orchestrator_version_incompatible"'::jsonb;
  end if;
  if input_retained_runs<1 then issues:=issues||'"retention_invalid"'::jsonb; end if;
  if to_regclass('public.repository_execution_versions') is null
    or to_regclass('public.repository_execution_work_units') is null
    or to_regclass('public.repository_execution_work_unit_leases') is null
    or to_regclass('public.repository_execution_reviews') is null
    or to_regclass('public.repository_execution_idempotency') is null then
    issues:=issues||'"execution_tables_missing"'::jsonb;
  end if;
  if to_regprocedure('public.lease_repository_execution_work_unit(text,text,text,text,integer,integer)') is null
    or to_regprocedure('public.publish_repository_execution_output(text,text,text,text,text,text,jsonb,text,integer)') is null
    or to_regprocedure('public.submit_repository_execution_review(text,text,text,text,text,text,text,jsonb,jsonb,integer,text)') is null then
    issues:=issues||'"execution_rpc_contract_missing"'::jsonb;
  end if;
  if not exists(select 1 from pg_class where relname='repository_execution_leases_claim_idx')
    or not exists(select 1 from pg_class where relname='repository_execution_reviews_output_idx') then
    issues:=issues||'"execution_indexes_missing"'::jsonb;
  end if;
  if exists(
    select 1 from public.repository_execution_work_unit_leases lease
    left join public.repository_execution_work_units unit
      on unit.execution_version=lease.execution_version and unit.work_unit_id=lease.work_unit_id
    where unit.work_unit_id is null
  ) then issues:=issues||'"lease_contract_invalid"'::jsonb; end if;
  if input_guarded_execution_enabled is null then
    issues:=issues||'"guarded_execution_configuration_invalid"'::jsonb;
  end if;
  return query select jsonb_array_length(issues)=0,issues;
end; $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'repository_execution_versions','repository_executions','repository_execution_work_units',
    'repository_execution_work_unit_dependencies','repository_execution_approvals',
    'repository_execution_work_unit_leases','repository_execution_agent_outputs',
    'repository_execution_reviews','repository_execution_idempotency','repository_execution_diagnostics'
  ] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated',table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role',table_name);
  end loop;
end $$;

revoke all on function public.execution_payload_hash(jsonb) from public,anon,authenticated;
revoke all on function public.refresh_repository_execution(text) from public,anon,authenticated;
revoke all on function public.repository_execution_run_json(text) from public,anon,authenticated;
revoke all on function public.create_repository_execution(jsonb,text,integer) from public,anon,authenticated;
revoke all on function public.get_repository_execution(text,text,text) from public,anon,authenticated;
revoke all on function public.list_repository_executions(text,text,text,integer) from public,anon,authenticated;
revoke all on function public.decide_repository_execution(text,text,text,text,text,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.approve_repository_execution(text,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.reject_repository_execution(text,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.lease_repository_execution_work_unit(text,text,text,text,integer,integer) from public,anon,authenticated;
revoke all on function public.heartbeat_repository_execution_work_unit(text,text,text,text,text,text,integer) from public,anon,authenticated;
revoke all on function public.publish_repository_execution_output(text,text,text,text,text,text,jsonb,text,integer) from public,anon,authenticated;
revoke all on function public.submit_repository_execution_review(text,text,text,text,text,text,text,jsonb,jsonb,integer,text) from public,anon,authenticated;
revoke all on function public.fail_repository_execution_work_unit(text,text,text,text,text,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.cancel_repository_execution(text,text,text,text) from public,anon,authenticated;
revoke all on function public.supersede_repository_execution(text,text,text,text) from public,anon,authenticated;
revoke all on function public.recover_repository_execution_leases(timestamptz) from public,anon,authenticated;
revoke all on function public.collect_repository_executions(text,text,integer) from public,anon,authenticated;
revoke all on function public.verify_repository_execution_contract(text,boolean,integer) from public,anon,authenticated;

grant execute on function public.execution_payload_hash(jsonb) to service_role;
grant execute on function public.refresh_repository_execution(text) to service_role;
grant execute on function public.repository_execution_run_json(text) to service_role;
grant execute on function public.create_repository_execution(jsonb,text,integer) to service_role;
grant execute on function public.get_repository_execution(text,text,text) to service_role;
grant execute on function public.list_repository_executions(text,text,text,integer) to service_role;
grant execute on function public.approve_repository_execution(text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.reject_repository_execution(text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.lease_repository_execution_work_unit(text,text,text,text,integer,integer) to service_role;
grant execute on function public.heartbeat_repository_execution_work_unit(text,text,text,text,text,text,integer) to service_role;
grant execute on function public.publish_repository_execution_output(text,text,text,text,text,text,jsonb,text,integer) to service_role;
grant execute on function public.submit_repository_execution_review(text,text,text,text,text,text,text,jsonb,jsonb,integer,text) to service_role;
grant execute on function public.fail_repository_execution_work_unit(text,text,text,text,text,text,text,text,boolean) to service_role;
grant execute on function public.cancel_repository_execution(text,text,text,text) to service_role;
grant execute on function public.supersede_repository_execution(text,text,text,text) to service_role;
grant execute on function public.recover_repository_execution_leases(timestamptz) to service_role;
grant execute on function public.collect_repository_executions(text,text,integer) to service_role;
grant execute on function public.verify_repository_execution_contract(text,boolean,integer) to service_role;
