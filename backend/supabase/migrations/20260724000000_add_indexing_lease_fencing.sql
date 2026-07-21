alter table public.indexing_jobs
  add column if not exists claim_token text;

update public.indexing_jobs
set claim_token = gen_random_uuid()::text
where claimed_by is not null and claim_token is null;

alter table public.indexing_jobs
  drop constraint if exists indexing_jobs_claim_token_consistent,
  add constraint indexing_jobs_claim_token_consistent check (
    (status in ('queued', 'cancelled') and claim_token is null)
    or (
      status in ('claimed', 'running', 'succeeded', 'failed')
      and claim_token is not null and btrim(claim_token) <> ''
    )
  );

create unique index if not exists indexing_jobs_claim_token_uidx
  on public.indexing_jobs (claim_token) where claim_token is not null;

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
  if new.status in ('queued', 'cancelled') then
    new.claim_token := null;
  end if;
  return new;
end;
$$;

create or replace function public.claim_next_indexing_job(
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
      claim_token = gen_random_uuid()::text,
      started_order = nextval('public.indexing_job_order_seq'),
      next_retry_at = null,
      lease_expires_at = now() + make_interval(secs => input_lease_ms::double precision / 1000.0)
  from next_job
  where jobs.job_id = next_job.job_id and jobs.status = 'queued'
  returning jobs.*;
end;
$$;

drop function if exists public.heartbeat_indexing_job(text, text, integer);
create function public.heartbeat_indexing_job(
  input_job_id text,
  input_worker_id text,
  input_claim_token text,
  input_lease_ms integer default 300000
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if input_lease_ms < 1000 or input_lease_ms > 86400000 then
    raise check_violation using message = 'indexing job lease duration is invalid';
  end if;
  update public.indexing_jobs
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => input_lease_ms::double precision / 1000.0)
  where job_id = input_job_id
    and claimed_by = input_worker_id
    and claim_token = input_claim_token
    and status in ('claimed', 'running')
    and lease_expires_at > now();
  return found;
end;
$$;

create or replace function public.mark_indexing_job_running(
  input_job_id text,
  input_worker_id text,
  input_claim_token text,
  input_stage text
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  update public.indexing_jobs jobs
  set status = 'running', current_stage = input_stage, heartbeat_at = now()
  where jobs.job_id = input_job_id
    and jobs.claimed_by = input_worker_id
    and jobs.claim_token = input_claim_token
    and jobs.status = 'claimed'
    and jobs.lease_expires_at > now()
  returning jobs.*;
  if found then
    update public.repositories repositories
    set status = case when repositories.indexed_revision is null then 'indexing' else 'indexed' end,
        updated_at = now()
    where repositories.repository_id = (
      select jobs.repository_id from public.indexing_jobs jobs
      where jobs.job_id = input_job_id and jobs.claim_token = input_claim_token
    ) and repositories.owner_user_id = (
      select jobs.owner_user_id from public.indexing_jobs jobs
      where jobs.job_id = input_job_id and jobs.claim_token = input_claim_token
    );
    if not found then
      raise foreign_key_violation using message = 'indexing job repository ownership is invalid';
    end if;
  end if;
end;
$$;

create or replace function public.update_indexing_job_progress(
  input_job_id text,
  input_worker_id text,
  input_claim_token text,
  input_progress integer,
  input_stage text
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_progress integer;
begin
  if input_progress < 0 or input_progress >= 100 then
    raise check_violation using message = 'indexing job progress is invalid';
  end if;
  select jobs.progress into current_progress from public.indexing_jobs jobs
  where jobs.job_id = input_job_id
    and jobs.claimed_by = input_worker_id
    and jobs.claim_token = input_claim_token
    and jobs.status = 'running'
    and jobs.lease_expires_at > now()
  for update;
  if not found then return; end if;
  if input_progress < current_progress then
    raise check_violation using message = 'indexing job progress cannot decrease';
  end if;
  return query
  update public.indexing_jobs jobs
  set progress = input_progress,
      current_stage = coalesce(input_stage, jobs.current_stage),
      last_progress_at = now()
  where jobs.job_id = input_job_id
    and jobs.claimed_by = input_worker_id
    and jobs.claim_token = input_claim_token
    and jobs.status = 'running'
    and jobs.lease_expires_at > now()
  returning jobs.*;
end;
$$;

create or replace function public.complete_indexing_job(
  input_job_id text,
  input_worker_id text,
  input_claim_token text
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  update public.indexing_jobs jobs
  set status = 'succeeded', progress = 100, current_stage = 'complete'
  where jobs.job_id = input_job_id
    and jobs.claimed_by = input_worker_id
    and jobs.claim_token = input_claim_token
    and jobs.status = 'running'
    and jobs.lease_expires_at > now()
  returning jobs.*;
  if found then return; end if;

  return query select jobs.* from public.indexing_jobs jobs
  where jobs.job_id = input_job_id
    and jobs.claimed_by = input_worker_id
    and jobs.claim_token = input_claim_token
    and jobs.status = 'succeeded';
end;
$$;

create or replace function public.fail_indexing_job(
  input_job_id text,
  input_worker_id text,
  input_claim_token text,
  input_failure_code text,
  input_failure_message text,
  input_failure_retryable boolean
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  update public.indexing_jobs jobs
  set status = 'failed', failure_code = input_failure_code,
      failure_message = input_failure_message,
      failure_retryable = input_failure_retryable
  where jobs.job_id = input_job_id
    and jobs.claimed_by = input_worker_id
    and jobs.claim_token = input_claim_token
    and jobs.status in ('claimed', 'running')
    and jobs.lease_expires_at > now()
  returning jobs.*;
  if found then
    update public.repositories repositories
    set status = case when repositories.indexed_revision is null then 'failed' else 'indexed' end,
        failure_message = input_failure_message,
        failed_at = now(), updated_at = now()
    where repositories.repository_id = (
      select jobs.repository_id from public.indexing_jobs jobs
      where jobs.job_id = input_job_id and jobs.claim_token = input_claim_token
    ) and repositories.owner_user_id = (
      select jobs.owner_user_id from public.indexing_jobs jobs
      where jobs.job_id = input_job_id and jobs.claim_token = input_claim_token
    );
    if not found then
      raise foreign_key_violation using message = 'indexing job repository ownership is invalid';
    end if;
  end if;
end;
$$;

create or replace function public.cancel_claimed_indexing_job(
  input_job_id text,
  input_worker_id text,
  input_claim_token text
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  return query
  update public.indexing_jobs jobs
  set status = 'cancelled'
  where jobs.job_id = input_job_id
    and jobs.claimed_by = input_worker_id
    and jobs.claim_token = input_claim_token
    and jobs.status = 'claimed'
    and jobs.lease_expires_at > now()
  returning jobs.*;
end;
$$;

drop function if exists public.schedule_indexing_job_retry(text, text, text, text, integer);
create function public.schedule_indexing_job_retry(
  input_job_id text,
  input_worker_id text,
  input_claim_token text,
  input_failure_code text,
  input_failure_message text,
  input_delay_ms integer
)
returns setof public.indexing_jobs
language plpgsql
security invoker
set search_path = public
as $$
begin
  if input_delay_ms < 0 or input_delay_ms > 3600000 then
    raise check_violation using message = 'retry delay is invalid';
  end if;
  return query
  update public.indexing_jobs jobs
  set status = 'queued', attempt = jobs.attempt + 1,
      progress = 0, current_stage = 'pending', claimed_by = null,
      claim_token = null, started_order = null, completed_order = null,
      failure_code = null, failure_message = null, failure_retryable = null,
      next_retry_at = now() + make_interval(secs => input_delay_ms::double precision / 1000.0)
  where jobs.job_id = input_job_id
    and jobs.claimed_by = input_worker_id
    and jobs.claim_token = input_claim_token
    and jobs.status = 'failed'
    and jobs.failure_retryable is true
    and jobs.failure_code = input_failure_code
    and jobs.failure_message = input_failure_message
    and jobs.attempt < jobs.max_attempts
  returning jobs.*;
end;
$$;

create or replace function public.recover_stale_indexing_jobs(
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
        or (lease_expires_at is null and greatest(
          coalesce(heartbeat_at, '-infinity'::timestamptz),
          coalesce(last_progress_at, '-infinity'::timestamptz),
          coalesce(claimed_at, updated_at)
        ) < input_stale_before)
      )
    order by coalesce(lease_expires_at, claimed_at), job_id
    for update skip locked
  loop
    update public.indexing_jobs
    set status = 'failed', failure_code = 'abandoned_lease',
        failure_message = 'Indexing worker lease expired before completion.',
        failure_retryable = (stale_job.attempt < stale_job.max_attempts),
        recovery_count = recovery_count + 1
    where job_id = stale_job.job_id
      and claimed_by = stale_job.claimed_by
      and claim_token = stale_job.claim_token
      and status in ('claimed', 'running')
      and (lease_expires_at is null or lease_expires_at <= input_expired_before)
    returning * into recovered_job;
    if not found then continue; end if;

    if recovered_job.failure_retryable then
      update public.indexing_jobs
      set status = 'queued', attempt = recovered_job.attempt + 1,
          progress = 0, current_stage = 'pending', claimed_by = null,
          claim_token = null, started_order = null, completed_order = null,
          failure_code = null, failure_message = null, failure_retryable = null,
          next_retry_at = now() + make_interval(secs => input_retry_delay_ms::double precision / 1000.0)
      where job_id = recovered_job.job_id and status = 'failed'
        and claim_token = recovered_job.claim_token
      returning * into recovered_job;
    end if;
    return next recovered_job;
  end loop;
end;
$$;

drop function if exists public.begin_repository_snapshot(text, text, text, text, text);
create function public.begin_repository_snapshot(
  input_repository_id text,
  input_revision text,
  input_branch text,
  input_job_id text,
  input_worker_id text,
  input_claim_token text
)
returns table (
  already_published boolean, chunk_count integer, file_count integer,
  symbol_count integer, graph_node_count integer, graph_edge_count integer,
  summary_available boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  repository_row public.repositories%rowtype;
begin
  if input_revision is null or input_revision !~ '^[0-9a-f]{40}$' then
    raise check_violation using message = 'repository revision must be a full lowercase commit SHA';
  end if;
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and status = 'running' and lease_expires_at > now()
  for update;
  if not found then raise serialization_failure using message = 'indexing_job_lease_conflict'; end if;

  select * into repository_row from public.repositories
  where repository_id = input_repository_id for update;
  if not found then raise foreign_key_violation using message = 'repository does not exist'; end if;
  if repository_row.indexed_revision = input_revision then
    return query select true, repository_row.chunk_count, repository_row.file_count,
      repository_row.symbol_count, repository_row.graph_node_count,
      repository_row.graph_edge_count, repository_row.metadata_available;
    return;
  end if;

  update public.repository_snapshots set status = 'failed', updated_at = now()
  where repository_id = input_repository_id and job_id = input_job_id
    and status = 'building' and revision <> input_revision;
  insert into public.repository_snapshots (
    repository_id, revision, commit_sha, branch, job_id, status, updated_at
  ) values (
    input_repository_id, input_revision, input_revision, input_branch,
    input_job_id, 'building', now()
  ) on conflict (repository_id, revision) do update set
    branch = excluded.branch, job_id = excluded.job_id, status = 'building',
    indexed_at = null, updated_at = now()
  where repository_snapshots.status in ('failed', 'superseded');
  if not exists (
    select 1 from public.repository_snapshots
    where repository_id = input_repository_id and revision = input_revision
      and job_id = input_job_id and status = 'building'
  ) then raise check_violation using message = 'repository revision is already being built'; end if;
  return query select false, 0, 0, 0, 0, 0, false;
end;
$$;

create or replace function public.save_repository_snapshot_summary(
  input_repository_id text,
  input_revision text,
  input_job_id text,
  input_worker_id text,
  input_claim_token text,
  input_summary jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and status = 'running' and lease_expires_at > now()
  for update;
  if not found then raise serialization_failure using message = 'indexing_job_lease_conflict'; end if;
  perform 1 from public.repository_snapshots
  where repository_id = input_repository_id and revision = input_revision
    and job_id = input_job_id and status = 'building'
  for update;
  if not found then raise check_violation using message = 'repository snapshot is not being built'; end if;
  insert into public.repository_summaries (
    repository, repository_revision, summary_kind, summary, updated_at
  ) values (
    input_repository_id, input_revision, 'architecture', input_summary, now()
  ) on conflict (repository, repository_revision, summary_kind) do update set
    summary = excluded.summary, updated_at = excluded.updated_at;
end;
$$;

drop function if exists public.publish_repository_snapshot(text, text, text, text, text, integer, integer, integer, integer, integer, boolean, text, integer);
create function public.publish_repository_snapshot(
  input_repository_id text,
  input_revision text,
  input_branch text,
  input_job_id text,
  input_worker_id text,
  input_claim_token text,
  input_chunk_count integer,
  input_file_count integer,
  input_symbol_count integer,
  input_graph_node_count integer,
  input_graph_edge_count integer,
  input_summary_available boolean,
  input_index_mode text,
  input_changed_file_count integer
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  actual_chunk_count bigint;
  published_at timestamptz := now();
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and status = 'running' and lease_expires_at > published_at
  for update;
  if not found then raise serialization_failure using message = 'indexing_job_lease_conflict'; end if;
  perform 1 from public.repositories where repository_id = input_repository_id for update;
  if not found then raise foreign_key_violation using message = 'repository does not exist'; end if;

  if not exists (
    select 1 from public.repositories
    where repository_id = input_repository_id and indexed_revision = input_revision
  ) then
    perform 1 from public.repository_snapshots
    where repository_id = input_repository_id and revision = input_revision
      and job_id = input_job_id and status = 'building'
    for update;
    if not found then raise check_violation using message = 'repository snapshot is not ready to publish'; end if;
    select count(*) into actual_chunk_count from public.repository_chunks
    where repository = input_repository_id and repository_revision = input_revision;
    if actual_chunk_count <> input_chunk_count then
      raise check_violation using message = 'repository snapshot chunk count does not match';
    end if;
    if not exists (
      select 1 from public.repository_summaries
      where repository = input_repository_id and repository_revision = input_revision
        and summary_kind = 'architecture'
    ) then raise check_violation using message = 'repository snapshot summary is missing'; end if;

    update public.repository_snapshots
    set status = 'superseded', indexed_at = null, updated_at = published_at
    where repository_id = input_repository_id and status = 'published';
    update public.repository_snapshots
    set status = 'published', indexed_at = published_at, updated_at = published_at,
      branch = input_branch, chunk_count = input_chunk_count,
      file_count = input_file_count, symbol_count = input_symbol_count,
      graph_node_count = input_graph_node_count, graph_edge_count = input_graph_edge_count,
      summary_available = input_summary_available
    where repository_id = input_repository_id and revision = input_revision
      and job_id = input_job_id and status = 'building';
    update public.repositories set
      status = 'indexed', indexed_revision = input_revision,
      indexed_at = published_at, first_indexed_at = coalesce(first_indexed_at, published_at),
      last_indexed_at = published_at, indexing_mode = input_index_mode,
      last_changed_file_count = input_changed_file_count,
      chunk_count = input_chunk_count, file_count = input_file_count,
      symbol_count = input_symbol_count, graph_node_count = input_graph_node_count,
      graph_edge_count = input_graph_edge_count, metadata_available = input_summary_available,
      total_indexed_files = input_file_count, updated_at = published_at
    where repository_id = input_repository_id;
    delete from public.repository_chunks
    where repository = input_repository_id and repository_revision <> input_revision;
    delete from public.repository_summaries
    where repository = input_repository_id and repository_revision <> input_revision;
  end if;

  update public.indexing_jobs set status = 'succeeded', progress = 100,
    current_stage = 'complete'
  where job_id = input_job_id and claimed_by = input_worker_id
    and claim_token = input_claim_token and status = 'running'
    and lease_expires_at > published_at;
  if not found then raise serialization_failure using message = 'indexing_job_lease_conflict'; end if;
end;
$$;

drop function if exists public.discard_repository_snapshot(text, text, text, text);
create function public.discard_repository_snapshot(
  input_repository_id text,
  input_revision text,
  input_job_id text,
  input_worker_id text,
  input_claim_token text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and status in ('claimed', 'running') and lease_expires_at > now()
  for update;
  if not found then raise serialization_failure using message = 'indexing_job_lease_conflict'; end if;
  if exists (
    select 1 from public.repositories
    where repository_id = input_repository_id and indexed_revision = input_revision
  ) then return; end if;
  delete from public.repository_chunks
  where repository = input_repository_id and repository_revision = input_revision;
  delete from public.repository_summaries
  where repository = input_repository_id and repository_revision = input_revision;
  update public.repository_snapshots set status = 'failed', indexed_at = null, updated_at = now()
  where repository_id = input_repository_id and revision = input_revision
    and job_id = input_job_id and status = 'building';
end;
$$;

revoke all on function public.heartbeat_indexing_job(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.mark_indexing_job_running(text, text, text, text) from public, anon, authenticated;
revoke all on function public.update_indexing_job_progress(text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.complete_indexing_job(text, text, text) from public, anon, authenticated;
revoke all on function public.fail_indexing_job(text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.cancel_claimed_indexing_job(text, text, text) from public, anon, authenticated;
revoke all on function public.schedule_indexing_job_retry(text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.begin_repository_snapshot(text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.save_repository_snapshot_summary(text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.publish_repository_snapshot(text, text, text, text, text, text, integer, integer, integer, integer, integer, boolean, text, integer) from public, anon, authenticated;
revoke all on function public.discard_repository_snapshot(text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.heartbeat_indexing_job(text, text, text, integer) to service_role;
grant execute on function public.mark_indexing_job_running(text, text, text, text) to service_role;
grant execute on function public.update_indexing_job_progress(text, text, text, integer, text) to service_role;
grant execute on function public.complete_indexing_job(text, text, text) to service_role;
grant execute on function public.fail_indexing_job(text, text, text, text, text, boolean) to service_role;
grant execute on function public.cancel_claimed_indexing_job(text, text, text) to service_role;
grant execute on function public.schedule_indexing_job_retry(text, text, text, text, text, integer) to service_role;
grant execute on function public.begin_repository_snapshot(text, text, text, text, text, text) to service_role;
grant execute on function public.save_repository_snapshot_summary(text, text, text, text, text, jsonb) to service_role;
grant execute on function public.publish_repository_snapshot(text, text, text, text, text, text, integer, integer, integer, integer, integer, boolean, text, integer) to service_role;
grant execute on function public.discard_repository_snapshot(text, text, text, text, text) to service_role;

comment on column public.indexing_jobs.claim_token is
  'Opaque per-claim fencing token; replaced on every successful claim and never returned by public APIs.';
