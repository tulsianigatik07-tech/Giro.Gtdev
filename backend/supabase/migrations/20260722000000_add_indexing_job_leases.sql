alter table public.indexing_jobs
  add column if not exists lease_expires_at timestamptz;

update public.indexing_jobs
set lease_expires_at = greatest(
  coalesce(heartbeat_at, '-infinity'::timestamptz),
  coalesce(last_progress_at, '-infinity'::timestamptz),
  coalesce(claimed_at, updated_at)
) + interval '5 minutes'
where status in ('claimed', 'running') and lease_expires_at is null;

create index if not exists indexing_jobs_expired_lease_idx
  on public.indexing_jobs (lease_expires_at, created_order, job_id)
  where status in ('claimed', 'running');

create or replace function public.clear_terminal_indexing_job_lease()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status not in ('claimed', 'running') then
    new.lease_expires_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists indexing_jobs_clear_terminal_lease on public.indexing_jobs;
create trigger indexing_jobs_clear_terminal_lease
before insert or update on public.indexing_jobs
for each row execute function public.clear_terminal_indexing_job_lease();

drop function if exists public.claim_next_indexing_job(text);
create function public.claim_next_indexing_job(
  input_worker_id text,
  input_lease_ms integer default 300000
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  if input_worker_id is null or btrim(input_worker_id) = '' then
    raise check_violation using message = 'indexing worker id must be non-empty';
  end if;
  if input_lease_ms < 1000 or input_lease_ms > 86400000 then
    raise check_violation using message = 'indexing job lease duration is invalid';
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
      started_order = nextval('public.indexing_job_order_seq'),
      next_retry_at = null,
      lease_expires_at = now() + make_interval(secs => input_lease_ms::double precision / 1000.0)
  from next_job
  where jobs.job_id = next_job.job_id and jobs.status = 'queued'
  returning jobs.*;
end;
$$;

drop function if exists public.heartbeat_indexing_job(text, text);
create function public.heartbeat_indexing_job(
  input_job_id text,
  input_worker_id text,
  input_lease_ms integer default 300000
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  renewed boolean;
begin
  if input_lease_ms < 1000 or input_lease_ms > 86400000 then
    raise check_violation using message = 'indexing job lease duration is invalid';
  end if;
  update public.indexing_jobs
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => input_lease_ms::double precision / 1000.0)
  where job_id = input_job_id
    and claimed_by = input_worker_id
    and status in ('claimed', 'running')
    and lease_expires_at > now();
  renewed := found;
  return renewed;
end;
$$;

drop function if exists public.recover_stale_indexing_jobs(timestamptz, integer);
create function public.recover_stale_indexing_jobs(
  input_stale_before timestamptz,
  input_retry_delay_ms integer,
  input_expired_before timestamptz default now()
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
      and (
        lease_expires_at <= input_expired_before
        or (
          lease_expires_at is null
          and greatest(
            coalesce(heartbeat_at, '-infinity'::timestamptz),
            coalesce(last_progress_at, '-infinity'::timestamptz),
            coalesce(claimed_at, updated_at)
          ) < input_stale_before
        )
      )
    order by coalesce(lease_expires_at, claimed_at), job_id
    for update skip locked
  loop
    update public.indexing_jobs
    set status = 'failed', failure_code = 'abandoned_lease',
        failure_message = 'Indexing worker lease expired before completion.',
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

revoke all on function public.claim_next_indexing_job(text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_indexing_job(text, text, integer) from public, anon, authenticated;
revoke all on function public.recover_stale_indexing_jobs(timestamptz, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_next_indexing_job(text, integer) to service_role;
grant execute on function public.heartbeat_indexing_job(text, text, integer) to service_role;
grant execute on function public.recover_stale_indexing_jobs(timestamptz, integer, timestamptz) to service_role;
