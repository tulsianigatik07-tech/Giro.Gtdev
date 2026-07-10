create sequence if not exists public.indexing_job_sequence_seq;
create sequence if not exists public.indexing_job_order_seq;

create table if not exists public.indexing_jobs (
  job_id text primary key,
  sequence bigint not null,
  repository_id text not null,
  owner_user_id text not null,
  repository_owner text not null,
  repository_name text not null,
  repository_url text not null,
  branch text,
  status text not null default 'queued',
  attempt integer not null default 1,
  max_attempts integer not null default 3,
  progress integer not null default 0,
  current_stage text not null default 'pending',
  failure_code text,
  failure_message text,
  failure_retryable boolean,
  claimed_by text,
  created_order bigint not null default nextval('public.indexing_job_order_seq'),
  started_order bigint,
  completed_order bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint indexing_jobs_sequence_positive check (sequence >= 1),
  constraint indexing_jobs_id_matches_sequence
    check (job_id = 'indexing-job-' || sequence::text),
  constraint indexing_jobs_repository_id_non_empty check (btrim(repository_id) <> ''),
  constraint indexing_jobs_owner_user_id_non_empty check (btrim(owner_user_id) <> ''),
  constraint indexing_jobs_repository_owner_non_empty check (btrim(repository_owner) <> ''),
  constraint indexing_jobs_repository_name_non_empty check (btrim(repository_name) <> ''),
  constraint indexing_jobs_repository_url_non_empty check (btrim(repository_url) <> ''),
  constraint indexing_jobs_repository_id_matches_owner_name
    check (repository_id = repository_owner || '/' || repository_name),
  constraint indexing_jobs_branch_non_empty check (branch is null or btrim(branch) <> ''),
  constraint indexing_jobs_status_valid
    check (status in ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled')),
  constraint indexing_jobs_stage_valid
    check (current_stage in (
      'pending', 'clone', 'scan', 'structure', 'symbols', 'graph',
      'chunk', 'embed', 'finalize', 'complete'
    )),
  constraint indexing_jobs_attempt_positive check (attempt >= 1),
  constraint indexing_jobs_max_attempts_positive check (max_attempts >= 1),
  constraint indexing_jobs_attempt_within_max check (attempt <= max_attempts),
  constraint indexing_jobs_progress_valid check (progress between 0 and 100),
  constraint indexing_jobs_completion_consistent
    check ((status = 'succeeded') = (progress = 100)),
  constraint indexing_jobs_complete_stage_consistent
    check ((status = 'succeeded') = (current_stage = 'complete')),
  constraint indexing_jobs_failure_consistent check (
    (
      status = 'failed'
      and failure_code is not null
      and btrim(failure_code) <> ''
      and failure_message is not null
      and btrim(failure_message) <> ''
      and failure_retryable is not null
    )
    or
    (
      status <> 'failed'
      and failure_code is null
      and failure_message is null
      and failure_retryable is null
    )
  ),
  constraint indexing_jobs_claim_consistent check (
    (status in ('queued', 'cancelled') and claimed_by is null)
    or
    (
      status in ('claimed', 'running', 'succeeded', 'failed')
      and claimed_by is not null
      and btrim(claimed_by) <> ''
    )
  ),
  constraint indexing_jobs_started_order_consistent check (
    (status = 'queued' and started_order is null)
    or
    (status in ('claimed', 'running', 'succeeded', 'failed') and started_order is not null)
    or
    status = 'cancelled'
  ),
  constraint indexing_jobs_completed_order_consistent check (
    (status in ('succeeded', 'failed', 'cancelled')) = (completed_order is not null)
  ),
  constraint indexing_jobs_created_order_positive check (created_order >= 1),
  constraint indexing_jobs_started_order_positive check (started_order is null or started_order >= 1),
  constraint indexing_jobs_completed_order_positive check (completed_order is null or completed_order >= 1),
  constraint indexing_jobs_sequence_unique unique (sequence),
  constraint indexing_jobs_created_order_unique unique (created_order)
);

create unique index if not exists indexing_jobs_repository_active_unique_idx
  on public.indexing_jobs (repository_id)
  where status in ('queued', 'claimed', 'running');

create index if not exists indexing_jobs_queued_claim_idx
  on public.indexing_jobs (created_order, sequence, job_id)
  where status = 'queued';

create index if not exists indexing_jobs_repository_history_idx
  on public.indexing_jobs (repository_id, created_order, sequence, job_id);

create index if not exists indexing_jobs_repository_latest_idx
  on public.indexing_jobs (repository_id, created_order desc, sequence desc, job_id desc);

create index if not exists indexing_jobs_owner_user_idx
  on public.indexing_jobs (owner_user_id, created_order desc);

create index if not exists indexing_jobs_status_idx
  on public.indexing_jobs (status, created_order, sequence, job_id);

create index if not exists indexing_jobs_stale_worker_idx
  on public.indexing_jobs (status, updated_at, started_order)
  where status in ('claimed', 'running');

create or replace function public.enforce_indexing_job_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.progress < old.progress then
    raise check_violation using message = 'indexing job progress cannot decrease';
  end if;

  if new.status <> old.status then
    if not (
      (old.status = 'queued' and new.status in ('claimed', 'cancelled'))
      or (old.status = 'claimed' and new.status in ('running', 'cancelled'))
      or (old.status = 'running' and new.status in ('succeeded', 'failed'))
      or (
        old.status = 'failed'
        and new.status = 'queued'
        and old.failure_retryable = true
        and old.attempt < old.max_attempts
      )
    ) then
      raise check_violation using message = 'invalid indexing job status transition';
    end if;

    if old.status = 'failed' and new.status = 'queued' then
      if new.attempt <> old.attempt + 1 then
        raise check_violation using message = 'indexing job retry must increment attempt';
      end if;
    elsif new.attempt <> old.attempt then
      raise check_violation using message = 'indexing job attempt changed outside retry';
    end if;
  elsif new.attempt <> old.attempt then
    raise check_violation using message = 'indexing job attempt changed without transition';
  end if;

  if new.status in ('succeeded', 'failed', 'cancelled') and new.completed_order is null then
    new.completed_order := nextval('public.indexing_job_order_seq');
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists indexing_jobs_lifecycle_trigger on public.indexing_jobs;
create trigger indexing_jobs_lifecycle_trigger
before update on public.indexing_jobs
for each row execute function public.enforce_indexing_job_lifecycle();

create or replace function public.create_indexing_job(
  input_repository_id text,
  input_owner_user_id text,
  input_repository_owner text,
  input_repository_name text,
  input_repository_url text,
  input_branch text,
  input_max_attempts integer
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
declare
  existing_job public.indexing_jobs%rowtype;
  created_job public.indexing_jobs%rowtype;
  allocated_sequence bigint;
begin
  select *
  into existing_job
  from public.indexing_jobs
  where repository_id = input_repository_id
    and status in ('queued', 'claimed', 'running')
  order by created_order, sequence, job_id
  limit 1;

  if found then
    return next existing_job;
    return;
  end if;

  begin
    allocated_sequence := nextval('public.indexing_job_sequence_seq');
    insert into public.indexing_jobs (
      job_id,
      sequence,
      repository_id,
      owner_user_id,
      repository_owner,
      repository_name,
      repository_url,
      branch,
      max_attempts
    ) values (
      'indexing-job-' || allocated_sequence::text,
      allocated_sequence,
      input_repository_id,
      input_owner_user_id,
      input_repository_owner,
      input_repository_name,
      input_repository_url,
      input_branch,
      input_max_attempts
    )
    returning * into created_job;
  exception when unique_violation then
    select *
    into existing_job
    from public.indexing_jobs
    where repository_id = input_repository_id
      and status in ('queued', 'claimed', 'running')
    order by created_order, sequence, job_id
    limit 1;

    if not found then
      raise;
    end if;

    return next existing_job;
    return;
  end;

  return next created_job;
end;
$$;

create or replace function public.claim_next_indexing_job(input_worker_id text)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  if input_worker_id is null or btrim(input_worker_id) = '' then
    raise check_violation using message = 'indexing worker id must be non-empty';
  end if;

  return query
  with next_job as (
    select job_id
    from public.indexing_jobs
    where status = 'queued'
    order by created_order, sequence, job_id
    for update skip locked
    limit 1
  )
  update public.indexing_jobs as jobs
  set
    status = 'claimed',
    claimed_by = input_worker_id,
    started_order = nextval('public.indexing_job_order_seq')
  from next_job
  where jobs.job_id = next_job.job_id
    and jobs.status = 'queued'
  returning jobs.*;
end;
$$;

alter table public.indexing_jobs enable row level security;

revoke all on table public.indexing_jobs from public, anon, authenticated;
revoke all on sequence public.indexing_job_sequence_seq from public, anon, authenticated;
revoke all on sequence public.indexing_job_order_seq from public, anon, authenticated;
revoke all on function public.enforce_indexing_job_lifecycle()
  from public, anon, authenticated;
revoke all on function public.create_indexing_job(text, text, text, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.claim_next_indexing_job(text)
  from public, anon, authenticated;

grant all on table public.indexing_jobs to service_role;
grant usage, select on sequence public.indexing_job_sequence_seq to service_role;
grant usage, select on sequence public.indexing_job_order_seq to service_role;
grant execute on function public.create_indexing_job(text, text, text, text, text, text, integer)
  to service_role;
grant execute on function public.claim_next_indexing_job(text) to service_role;

comment on table public.indexing_jobs is
  'Server-only durable indexing queue. Access requires the backend service role.';
comment on function public.claim_next_indexing_job(text) is
  'Atomically claims one queued indexing job using FOR UPDATE SKIP LOCKED.';
