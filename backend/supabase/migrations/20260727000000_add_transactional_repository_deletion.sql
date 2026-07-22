alter table public.repositories add column if not exists deletion_state text not null default 'active';
alter table public.repositories drop constraint if exists repositories_deletion_state_valid;
alter table public.repositories add constraint repositories_deletion_state_valid
  check (deletion_state in ('active', 'deleting'));
create index if not exists repositories_deletion_state_idx
  on public.repositories(deletion_state, updated_at);

create table if not exists public.repository_deletion_tombstones (
  repository_id text primary key,
  owner_user_id text not null,
  repository_owner text not null,
  repository_name text not null,
  deletion_state text not null default 'deleted',
  deleted_repository_version bigint not null,
  response_report jsonb not null,
  deleted_at timestamptz not null default now(),
  transaction_completed_at timestamptz not null default now(),
  cleanup_pending boolean not null default true,
  cleanup_attempts integer not null default 0,
  cleanup_last_error text,
  cleanup_completed_at timestamptz,
  constraint repository_deletion_tombstones_identity
    check (repository_id = repository_owner || '/' || repository_name),
  constraint repository_deletion_tombstones_state check (deletion_state = 'deleted'),
  constraint repository_deletion_tombstones_version check (deleted_repository_version >= 1),
  constraint repository_deletion_tombstones_attempts check (cleanup_attempts >= 0),
  constraint repository_deletion_tombstones_report_object check (jsonb_typeof(response_report) = 'object'),
  constraint repository_deletion_tombstones_cleanup_consistent check (
    (cleanup_pending and cleanup_completed_at is null)
    or (not cleanup_pending and cleanup_completed_at is not null and cleanup_last_error is null)
  )
);
create index if not exists repository_deletion_tombstones_cleanup_pending_idx
  on public.repository_deletion_tombstones(deleted_at, repository_id) where cleanup_pending;
create index if not exists repository_deletion_tombstones_owner_idx
  on public.repository_deletion_tombstones(owner_user_id, deleted_at desc);

alter table public.repository_deletion_tombstones enable row level security;
revoke all on table public.repository_deletion_tombstones from public, anon, authenticated;
grant all on table public.repository_deletion_tombstones to service_role;

create or replace function public.delete_repository_transactionally(
  input_repository_id text,
  input_owner_user_id text,
  input_expected_version bigint,
  input_response_report jsonb
)
returns setof public.repository_deletion_tombstones
language plpgsql security invoker set search_path = public as $$
declare repository_row public.repositories%rowtype; tombstone public.repository_deletion_tombstones%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(input_repository_id, 0));
  select * into tombstone from public.repository_deletion_tombstones
    where repository_id = input_repository_id for update;
  if found then
    if tombstone.owner_user_id <> input_owner_user_id then
      raise insufficient_privilege using message = 'repository_not_owned';
    end if;
    return next tombstone;
    return;
  end if;

  select * into repository_row from public.repositories
    where repository_id = input_repository_id for update;
  if not found then raise no_data_found using message = 'repository_not_found'; end if;
  if repository_row.owner_user_id is distinct from input_owner_user_id then
    raise insufficient_privilege using message = 'repository_not_owned';
  end if;
  if repository_row.repository_version <> input_expected_version then
    raise serialization_failure using message = 'repository_concurrency_conflict';
  end if;
  if repository_row.deletion_state <> 'active' then
    raise serialization_failure using message = 'repository_deletion_in_progress';
  end if;

  update public.repositories set deletion_state = 'deleting',
    repository_version = repository_version + 1, publishing_revision = null, updated_at = now()
    where repository_id = input_repository_id and repository_version = input_expected_version;
  if not found then raise serialization_failure using message = 'repository_concurrency_conflict'; end if;

  -- Removing every job in the same transaction invalidates all leases and
  -- claim tokens and makes stale worker writes fail their fencing predicates.
  delete from public.indexing_jobs where repository_id = input_repository_id;

  insert into public.repository_deletion_tombstones(
    repository_id, owner_user_id, repository_owner, repository_name,
    deleted_repository_version, response_report, cleanup_pending
  ) values (
    repository_row.repository_id, input_owner_user_id,
    repository_row.repository_owner, repository_row.repository_name,
    input_expected_version + 1, input_response_report, true
  ) returning * into tombstone;

  -- Repository-owned sessions, messages, snapshots, artifacts, summaries,
  -- chunks, and revision data cascade from this row.
  delete from public.repositories where repository_id = input_repository_id
    and deletion_state = 'deleting' and repository_version = input_expected_version + 1;
  if not found then raise serialization_failure using message = 'repository_deletion_fence_conflict'; end if;
  return next tombstone;
end; $$;

create or replace function public.record_repository_deletion_cleanup(
  input_repository_id text, input_succeeded boolean, input_error text default null
)
returns setof public.repository_deletion_tombstones
language plpgsql security invoker set search_path = public as $$
begin
  return query update public.repository_deletion_tombstones tombstones set
    cleanup_pending = not input_succeeded,
    cleanup_attempts = cleanup_attempts + 1,
    cleanup_last_error = case when input_succeeded then null else left(coalesce(input_error, 'filesystem cleanup failed'), 2000) end,
    cleanup_completed_at = case when input_succeeded then now() else null end
  where repository_id = input_repository_id returning tombstones.*;
end; $$;

-- Job creation takes a row lock compatible with deletion's FOR UPDATE fence.
create or replace function public.create_indexing_job(
  input_repository_id text, input_owner_user_id text,
  input_repository_owner text, input_repository_name text,
  input_repository_url text, input_branch text, input_max_attempts integer,
  input_request_id text default null, input_traceparent text default null
)
returns setof public.indexing_jobs language plpgsql security invoker set search_path = public as $$
declare existing_job public.indexing_jobs%rowtype; created_job public.indexing_jobs%rowtype; allocated_sequence bigint;
begin
  perform 1 from public.repositories where repository_id = input_repository_id
    and owner_user_id = input_owner_user_id and deletion_state = 'active' for key share;
  if not found then raise foreign_key_violation using message = 'repository_deleting_or_deleted'; end if;
  select * into existing_job from public.indexing_jobs where repository_id = input_repository_id
    and status in ('queued','claimed','running') order by created_order, sequence, job_id limit 1;
  if found then return next existing_job; return; end if;
  begin
    allocated_sequence := nextval('public.indexing_job_sequence_seq');
    insert into public.indexing_jobs(job_id, sequence, repository_id, owner_user_id,
      repository_owner, repository_name, repository_url, branch, max_attempts, request_id, traceparent)
    values('indexing-job-' || allocated_sequence::text, allocated_sequence, input_repository_id,
      input_owner_user_id, input_repository_owner, input_repository_name, input_repository_url,
      input_branch, input_max_attempts, input_request_id, input_traceparent)
    returning * into created_job;
  exception when unique_violation then
    select * into existing_job from public.indexing_jobs where repository_id = input_repository_id
      and status in ('queued','claimed','running') order by created_order, sequence, job_id limit 1;
    if not found then raise; end if;
    return next existing_job; return;
  end;
  return next created_job;
end; $$;

create or replace function public.claim_next_indexing_job(
  input_worker_id text, input_lease_ms integer default 300000
)
returns setof public.indexing_jobs language plpgsql security invoker set search_path = public as $$
begin
  if input_worker_id is null or btrim(input_worker_id) = '' then raise check_violation using message = 'indexing worker id must be non-empty'; end if;
  if input_lease_ms < 1000 or input_lease_ms > 86400000 then raise check_violation using message = 'indexing job lease duration is invalid'; end if;
  return query with next_job as (
    select jobs.job_id from public.indexing_jobs jobs join public.repositories repositories
      on repositories.repository_id = jobs.repository_id and repositories.deletion_state = 'active'
    where jobs.status = 'queued' and (jobs.next_retry_at is null or jobs.next_retry_at <= now())
    order by coalesce(jobs.next_retry_at, jobs.created_at), jobs.created_order, jobs.sequence, jobs.job_id
    for update of jobs skip locked limit 1
  ) update public.indexing_jobs jobs set status = 'claimed', claimed_by = input_worker_id,
      claim_token = gen_random_uuid()::text, started_order = nextval('public.indexing_job_order_seq'),
      next_retry_at = null, lease_expires_at = now() + make_interval(secs => input_lease_ms::double precision / 1000.0)
    from next_job where jobs.job_id = next_job.job_id and jobs.status = 'queued' returning jobs.*;
end; $$;

revoke all on function public.delete_repository_transactionally(text,text,bigint,jsonb) from public, anon, authenticated;
revoke all on function public.record_repository_deletion_cleanup(text,boolean,text) from public, anon, authenticated;
grant execute on function public.delete_repository_transactionally(text,text,bigint,jsonb) to service_role;
grant execute on function public.record_repository_deletion_cleanup(text,boolean,text) to service_role;
