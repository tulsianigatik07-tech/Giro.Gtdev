alter table public.indexing_jobs
  add column if not exists claimed_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists last_progress_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists next_retry_at timestamptz,
  add column if not exists failure_category text,
  add column if not exists recovery_count integer not null default 0;

alter table public.indexing_jobs
  drop constraint if exists indexing_jobs_failure_category_valid;
alter table public.indexing_jobs
  add constraint indexing_jobs_failure_category_valid
  check (failure_category is null or failure_category in ('retryable', 'terminal'));
alter table public.indexing_jobs
  drop constraint if exists indexing_jobs_recovery_count_valid;
alter table public.indexing_jobs
  add constraint indexing_jobs_recovery_count_valid check (recovery_count >= 0);

update public.indexing_jobs
set
  claimed_at = case when status in ('claimed', 'running', 'succeeded', 'failed') then updated_at else claimed_at end,
  started_at = case when status in ('running', 'succeeded', 'failed') then updated_at else started_at end,
  heartbeat_at = case when status in ('claimed', 'running') then updated_at else heartbeat_at end,
  last_progress_at = case when status in ('running', 'succeeded', 'failed') then updated_at else last_progress_at end,
  completed_at = case when status in ('succeeded', 'failed', 'cancelled') then updated_at else completed_at end,
  failed_at = case when status = 'failed' then updated_at else failed_at end,
  failure_category = case
    when status = 'failed' and failure_retryable then 'retryable'
    when status = 'failed' then 'terminal'
    else null
  end;

create index if not exists indexing_jobs_retry_poll_idx
  on public.indexing_jobs (next_retry_at, created_order, sequence, job_id)
  where status = 'queued';
create index if not exists indexing_jobs_stale_claim_idx
  on public.indexing_jobs (heartbeat_at, last_progress_at, claimed_at, job_id)
  where status in ('claimed', 'running');

create or replace function public.enforce_indexing_job_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status = 'failed' and new.status = 'queued' then
    new.progress := 0;
    new.current_stage := 'pending';
  elsif new.progress < old.progress then
    raise check_violation using message = 'indexing job progress cannot decrease';
  end if;

  if new.status <> old.status then
    if not (
      (old.status = 'queued' and new.status in ('claimed', 'cancelled'))
      or (old.status = 'claimed' and new.status in ('running', 'cancelled', 'failed'))
      or (old.status = 'running' and new.status in ('succeeded', 'failed'))
      or (
        old.status = 'failed' and new.status = 'queued'
        and old.failure_retryable = true and old.attempt < old.max_attempts
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

  if old.status = 'queued' and new.status = 'claimed' then
    new.claimed_at := now();
    new.heartbeat_at := now();
    new.last_progress_at := now();
  elsif old.status = 'claimed' and new.status = 'running' then
    new.started_at := now();
    new.heartbeat_at := now();
    new.last_progress_at := now();
  elsif new.status = 'running' and new.progress > old.progress then
    new.last_progress_at := now();
    new.heartbeat_at := now();
  end if;

  if new.status = 'failed' then
    new.failed_at := now();
    new.completed_at := now();
    new.failure_category := case when new.failure_retryable then 'retryable' else 'terminal' end;
  elsif new.status in ('succeeded', 'cancelled') then
    new.completed_at := now();
    new.failure_category := null;
  elsif new.status = 'queued' then
    new.claimed_at := null;
    new.started_at := null;
    new.heartbeat_at := null;
    new.last_progress_at := null;
    new.completed_at := null;
    new.failed_at := null;
    new.failure_category := null;
  end if;

  if new.status in ('succeeded', 'failed', 'cancelled') and new.completed_order is null then
    new.completed_order := nextval('public.indexing_job_order_seq');
  end if;

  new.updated_at := now();
  return new;
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
    select job_id from public.indexing_jobs
    where status = 'queued'
      and (next_retry_at is null or next_retry_at <= now())
    order by coalesce(next_retry_at, created_at), created_order, sequence, job_id
    for update skip locked limit 1
  )
  update public.indexing_jobs as jobs
  set status = 'claimed', claimed_by = input_worker_id,
      started_order = nextval('public.indexing_job_order_seq'), next_retry_at = null
  from next_job
  where jobs.job_id = next_job.job_id and jobs.status = 'queued'
  returning jobs.*;
end;
$$;

create or replace function public.heartbeat_indexing_job(
  input_job_id text,
  input_worker_id text
)
returns boolean
language sql
security invoker
set search_path = public
as $$
  with updated as (
    update public.indexing_jobs
    set heartbeat_at = now()
    where job_id = input_job_id
      and claimed_by = input_worker_id
      and status in ('claimed', 'running')
    returning 1
  )
  select exists(select 1 from updated);
$$;

create or replace function public.schedule_indexing_job_retry(
  input_job_id text,
  input_worker_id text,
  input_failure_code text,
  input_failure_message text,
  input_delay_ms integer
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
declare
  failed_job public.indexing_jobs%rowtype;
  queued_job public.indexing_jobs%rowtype;
begin
  if input_delay_ms < 0 or input_delay_ms > 3600000 then
    raise check_violation using message = 'retry delay is invalid';
  end if;
  select * into failed_job from public.indexing_jobs
  where job_id = input_job_id and status = 'failed' and claimed_by = input_worker_id
  for update;
  if not found or failed_job.failure_retryable is not true or failed_job.attempt >= failed_job.max_attempts then
    return;
  end if;

  update public.indexing_jobs
  set status = 'queued', attempt = failed_job.attempt + 1,
      progress = 0, current_stage = 'pending', claimed_by = null,
      started_order = null, completed_order = null,
      failure_code = null, failure_message = null, failure_retryable = null,
      next_retry_at = now() + make_interval(secs => input_delay_ms::double precision / 1000.0)
  where job_id = input_job_id and status = 'failed'
  returning * into queued_job;
  return next queued_job;
end;
$$;

create or replace function public.recover_stale_indexing_jobs(
  input_stale_before timestamptz,
  input_retry_delay_ms integer
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
declare
  stale_job public.indexing_jobs%rowtype;
  recovered_job public.indexing_jobs%rowtype;
begin
  if input_retry_delay_ms < 0 or input_retry_delay_ms > 3600000 then
    raise check_violation using message = 'retry delay is invalid';
  end if;
  for stale_job in
    select * from public.indexing_jobs
    where status in ('claimed', 'running')
      and greatest(
        coalesce(heartbeat_at, '-infinity'::timestamptz),
        coalesce(last_progress_at, '-infinity'::timestamptz),
        coalesce(claimed_at, updated_at)
      ) < input_stale_before
    order by claimed_at, job_id
    for update skip locked
  loop
    update public.indexing_jobs
    set status = 'failed', failure_code = 'stale_worker_claim',
        failure_message = 'Indexing worker stopped reporting progress.',
        failure_retryable = (stale_job.attempt < stale_job.max_attempts),
        recovery_count = recovery_count + 1
    where job_id = stale_job.job_id and status in ('claimed', 'running')
    returning * into recovered_job;

    if recovered_job.failure_retryable then
      update public.indexing_jobs
      set status = 'queued', attempt = recovered_job.attempt + 1,
          progress = 0, current_stage = 'pending', claimed_by = null,
          started_order = null, completed_order = null,
          failure_code = null, failure_message = null, failure_retryable = null,
          next_retry_at = now() + make_interval(secs => input_retry_delay_ms::double precision / 1000.0)
      where job_id = recovered_job.job_id and status = 'failed'
      returning * into recovered_job;
    end if;
    return next recovered_job;
  end loop;
end;
$$;

create table if not exists public.indexing_workers (
  worker_id text primary key,
  shutdown_state text not null check (shutdown_state in ('running', 'stopping', 'stopped')),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  last_poll_at timestamptz,
  active_job_id text references public.indexing_jobs(job_id) on delete set null,
  last_completed_job_id text references public.indexing_jobs(job_id) on delete set null,
  last_error_code text,
  last_error_message text,
  stopped_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint indexing_workers_id_non_empty check (btrim(worker_id) <> '')
);

create index if not exists indexing_workers_health_idx
  on public.indexing_workers (shutdown_state, heartbeat_at desc);

create or replace function public.record_indexing_worker_state(
  input_worker_id text,
  input_shutdown_state text,
  input_active_job_id text,
  input_last_completed_job_id text,
  input_last_error_code text,
  input_last_error_message text,
  input_polled boolean
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.indexing_workers (
    worker_id, shutdown_state, active_job_id, last_completed_job_id,
    last_error_code, last_error_message, last_poll_at, stopped_at
  ) values (
    input_worker_id, input_shutdown_state, input_active_job_id, input_last_completed_job_id,
    input_last_error_code, input_last_error_message,
    case when input_polled then now() else null end,
    case when input_shutdown_state = 'stopped' then now() else null end
  )
  on conflict (worker_id) do update set
    shutdown_state = excluded.shutdown_state,
    active_job_id = excluded.active_job_id,
    last_completed_job_id = coalesce(excluded.last_completed_job_id, indexing_workers.last_completed_job_id),
    last_error_code = coalesce(excluded.last_error_code, indexing_workers.last_error_code),
    last_error_message = coalesce(excluded.last_error_message, indexing_workers.last_error_message),
    last_poll_at = coalesce(excluded.last_poll_at, indexing_workers.last_poll_at),
    heartbeat_at = now(),
    stopped_at = case when excluded.shutdown_state = 'stopped' then now() else null end,
    updated_at = now();
end;
$$;

alter table public.indexing_workers enable row level security;
revoke all on table public.indexing_workers from public, anon, authenticated;
revoke all on function public.heartbeat_indexing_job(text, text) from public, anon, authenticated;
revoke all on function public.schedule_indexing_job_retry(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.recover_stale_indexing_jobs(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.record_indexing_worker_state(text, text, text, text, text, text, boolean) from public, anon, authenticated;
grant all on table public.indexing_workers to service_role;
grant execute on function public.claim_next_indexing_job(text) to service_role;
grant execute on function public.heartbeat_indexing_job(text, text) to service_role;
grant execute on function public.schedule_indexing_job_retry(text, text, text, text, integer) to service_role;
grant execute on function public.recover_stale_indexing_jobs(timestamptz, integer) to service_role;
grant execute on function public.record_indexing_worker_state(text, text, text, text, text, text, boolean) to service_role;

comment on table public.indexing_workers is
  'Durable service-role-only health state for supervised indexing workers.';
comment on function public.recover_stale_indexing_jobs(timestamptz, integer) is
  'Atomically recovers stale claims with row locking and bounded attempts.';
