create table if not exists public.repository_quota_usage (
  repository_id text primary key references public.repositories(repository_id) on delete cascade,
  owner_user_id text not null,
  storage_bytes bigint not null,
  indexed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint repository_quota_usage_storage_valid check (storage_bytes >= 0)
);
create index if not exists repository_quota_usage_owner_idx
  on public.repository_quota_usage(owner_user_id, repository_id);
alter table public.repository_quota_usage enable row level security;
revoke all on table public.repository_quota_usage from public, anon, authenticated;
grant all on table public.repository_quota_usage to service_role;

alter table public.indexing_jobs add column if not exists failure_details jsonb;
alter table public.indexing_jobs drop constraint if exists indexing_jobs_failure_details_object;
alter table public.indexing_jobs add constraint indexing_jobs_failure_details_object
  check (failure_details is null or jsonb_typeof(failure_details) = 'object');

create or replace function public.fail_indexing_job(
  input_job_id text, input_worker_id text, input_claim_token text,
  input_failure_code text, input_failure_message text, input_failure_retryable boolean,
  input_failure_details jsonb
)
returns setof public.indexing_jobs language plpgsql security invoker set search_path = public as $$
begin
  perform public.fail_indexing_job(input_job_id, input_worker_id, input_claim_token,
    input_failure_code, input_failure_message, input_failure_retryable);
  return query update public.indexing_jobs jobs set failure_details = input_failure_details
    where jobs.job_id = input_job_id and jobs.claimed_by = input_worker_id
      and jobs.claim_token = input_claim_token and jobs.status = 'failed'
    returning jobs.*;
end; $$;

create or replace function public.discard_repository_snapshot(
  input_repository_id text, input_revision text, input_job_id text,
  input_worker_id text, input_claim_token text
)
returns void language plpgsql security invoker set search_path = public as $$
begin
  perform 1 from public.indexing_jobs where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and ((status in ('claimed','running') and lease_expires_at > now()) or status = 'failed') for update;
  if not found then raise serialization_failure using message = 'indexing_job_lease_conflict'; end if;
  perform 1 from public.repositories where repository_id = input_repository_id for update;
  if exists (select 1 from public.repositories where repository_id = input_repository_id
    and current_revision = input_revision) then return; end if;
  if exists (select 1 from public.repositories where repository_id = input_repository_id
    and previous_revision = input_revision) then
    update public.repository_snapshots set status = 'superseded', indexed_at = null, updated_at = now()
      where repository_id = input_repository_id and revision = input_revision
        and job_id = input_job_id and status = 'building';
  else
    delete from public.repository_chunks where repository = input_repository_id and repository_revision = input_revision;
    delete from public.repository_summaries where repository = input_repository_id and repository_revision = input_revision;
    delete from public.repository_artifacts where repository_id = input_repository_id and repository_revision = input_revision;
    update public.repository_snapshots set status = 'failed', indexed_at = null, updated_at = now()
      where repository_id = input_repository_id and revision = input_revision
        and job_id = input_job_id and status = 'building';
  end if;
  update public.repositories set publishing_revision = null,
    status = case when current_revision is null then 'failed' else 'indexed' end,
    repository_version = repository_version + 1, updated_at = now()
    where repository_id = input_repository_id and publishing_revision = input_revision;
end; $$;

create or replace function public.create_indexing_job(
  input_repository_id text, input_owner_user_id text,
  input_repository_owner text, input_repository_name text,
  input_repository_url text, input_branch text, input_max_attempts integer,
  input_request_id text default null, input_traceparent text default null,
  input_max_concurrent_per_user integer default 2
)
returns setof public.indexing_jobs language plpgsql security invoker set search_path = public as $$
declare existing_job public.indexing_jobs%rowtype; created_job public.indexing_jobs%rowtype; allocated_sequence bigint; active_count bigint;
begin
  perform 1 from public.repositories where repository_id = input_repository_id
    and owner_user_id = input_owner_user_id and deletion_state = 'active' for key share;
  if not found then raise foreign_key_violation using message = 'repository_deleting_or_deleted'; end if;
  select * into existing_job from public.indexing_jobs where repository_id = input_repository_id
    and status in ('queued','claimed','running') order by created_order, sequence, job_id limit 1;
  if found then return next existing_job; return; end if;
  perform pg_advisory_xact_lock(hashtextextended('indexing-quota:' || input_owner_user_id, 0));
  select * into existing_job from public.indexing_jobs where repository_id = input_repository_id
    and status in ('queued','claimed','running') order by created_order, sequence, job_id limit 1;
  if found then return next existing_job; return; end if;
  select count(*) into active_count from public.indexing_jobs
    where owner_user_id = input_owner_user_id and status in ('queued','claimed','running');
  if active_count >= input_max_concurrent_per_user then
    raise check_violation using message = 'repository_quota_exceeded:concurrent_indexing';
  end if;
  allocated_sequence := nextval('public.indexing_job_sequence_seq');
  insert into public.indexing_jobs(job_id, sequence, repository_id, owner_user_id,
    repository_owner, repository_name, repository_url, branch, max_attempts, request_id, traceparent)
  values('indexing-job-' || allocated_sequence::text, allocated_sequence, input_repository_id,
    input_owner_user_id, input_repository_owner, input_repository_name, input_repository_url,
    input_branch, input_max_attempts, input_request_id, input_traceparent)
  returning * into created_job;
  return next created_job;
exception when unique_violation then
  select * into existing_job from public.indexing_jobs where repository_id = input_repository_id
    and status in ('queued','claimed','running') order by created_order, sequence, job_id limit 1;
  if not found then raise; end if;
  return next existing_job;
end; $$;

create or replace function public.stage_repository_artifacts(
  input_repository_id text, input_repository_revision text,
  input_job_id text, input_worker_id text, input_claim_token text,
  input_graph jsonb, input_summary jsonb, input_file_snapshot jsonb,
  input_symbol_index jsonb, input_graph_source jsonb,
  input_max_artifact_bytes bigint
)
returns void language plpgsql security invoker set search_path = public as $$
declare artifact_bytes bigint;
begin
  artifact_bytes := octet_length(input_graph::text) + octet_length(input_summary::text)
    + octet_length(input_file_snapshot::text) + octet_length(input_symbol_index::text)
    + octet_length(input_graph_source::text);
  if artifact_bytes > input_max_artifact_bytes then
    raise check_violation using message = 'repository_quota_exceeded:artifact_size';
  end if;
  perform public.stage_repository_artifacts(input_repository_id, input_repository_revision,
    input_job_id, input_worker_id, input_claim_token, input_graph, input_summary,
    input_file_snapshot, input_symbol_index, input_graph_source);
end; $$;

create or replace function public.publish_repository_snapshot(
  input_repository_id text, input_revision text, input_branch text,
  input_job_id text, input_worker_id text, input_claim_token text,
  input_chunk_count integer, input_file_count integer, input_symbol_count integer,
  input_graph_node_count integer, input_graph_edge_count integer,
  input_summary_available boolean, input_index_mode text, input_changed_file_count integer,
  input_owner_user_id text, input_repository_storage_bytes bigint,
  input_max_indexed_repositories integer, input_max_user_storage_bytes bigint
)
returns void language plpgsql security invoker set search_path = public as $$
declare repository_count bigint; existing_storage bigint; current_owner text;
begin
  perform pg_advisory_xact_lock(hashtextextended('publication-quota:' || input_owner_user_id, 0));
  select owner_user_id into current_owner from public.repositories
    where repository_id = input_repository_id for update;
  if current_owner is distinct from input_owner_user_id then
    raise insufficient_privilege using message = 'repository owner mismatch';
  end if;
  select count(*), coalesce(sum(storage_bytes), 0) into repository_count, existing_storage
    from public.repository_quota_usage
    where owner_user_id = input_owner_user_id and repository_id <> input_repository_id;
  if repository_count + 1 > input_max_indexed_repositories then
    raise check_violation using message = 'repository_quota_exceeded:indexed_repositories';
  end if;
  if existing_storage + input_repository_storage_bytes > input_max_user_storage_bytes then
    raise check_violation using message = 'repository_quota_exceeded:user_storage';
  end if;
  perform public.publish_repository_snapshot(input_repository_id, input_revision, input_branch,
    input_job_id, input_worker_id, input_claim_token, input_chunk_count, input_file_count,
    input_symbol_count, input_graph_node_count, input_graph_edge_count,
    input_summary_available, input_index_mode, input_changed_file_count);
  insert into public.repository_quota_usage(repository_id, owner_user_id, storage_bytes, indexed_at, updated_at)
    values(input_repository_id, input_owner_user_id, input_repository_storage_bytes, now(), now())
  on conflict(repository_id) do update set owner_user_id = excluded.owner_user_id,
    storage_bytes = excluded.storage_bytes, updated_at = now();
end; $$;

create or replace function public.get_user_repository_quota_usage(input_owner_user_id text)
returns table(indexed_repositories bigint, storage_bytes bigint, concurrent_jobs bigint)
language sql stable security invoker set search_path = public as $$
  select count(usage.repository_id), coalesce(sum(usage.storage_bytes), 0),
    (select count(*) from public.indexing_jobs jobs where jobs.owner_user_id = input_owner_user_id
      and jobs.status in ('queued','claimed','running'))
  from public.repository_quota_usage usage where usage.owner_user_id = input_owner_user_id;
$$;

revoke all on function public.create_indexing_job(text,text,text,text,text,text,integer,text,text,integer) from public, anon, authenticated;
revoke all on function public.stage_repository_artifacts(text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,bigint) from public, anon, authenticated;
revoke all on function public.publish_repository_snapshot(text,text,text,text,text,text,integer,integer,integer,integer,integer,boolean,text,integer,text,bigint,integer,bigint) from public, anon, authenticated;
revoke all on function public.get_user_repository_quota_usage(text) from public, anon, authenticated;
revoke all on function public.fail_indexing_job(text,text,text,text,text,boolean,jsonb) from public, anon, authenticated;
revoke all on function public.discard_repository_snapshot(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.create_indexing_job(text,text,text,text,text,text,integer,text,text,integer) to service_role;
grant execute on function public.stage_repository_artifacts(text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,bigint) to service_role;
grant execute on function public.publish_repository_snapshot(text,text,text,text,text,text,integer,integer,integer,integer,integer,boolean,text,integer,text,bigint,integer,bigint) to service_role;
grant execute on function public.get_user_repository_quota_usage(text) to service_role;
grant execute on function public.fail_indexing_job(text,text,text,text,text,boolean,jsonb) to service_role;
grant execute on function public.discard_repository_snapshot(text,text,text,text,text) to service_role;
