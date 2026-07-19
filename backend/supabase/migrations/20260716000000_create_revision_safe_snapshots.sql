create table if not exists public.repository_snapshots (
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  revision text not null,
  commit_sha text not null,
  branch text,
  job_id text not null references public.indexing_jobs(job_id) on delete cascade,
  status text not null default 'building',
  chunk_count integer not null default 0,
  file_count integer not null default 0,
  symbol_count integer not null default 0,
  graph_node_count integer not null default 0,
  graph_edge_count integer not null default 0,
  summary_available boolean not null default false,
  created_at timestamptz not null default now(),
  indexed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (repository_id, revision),
  constraint repository_snapshots_revision_sha check (revision ~ '^[0-9a-f]{40}$'),
  constraint repository_snapshots_commit_sha check (commit_sha ~ '^[0-9a-f]{40}$'),
  constraint repository_snapshots_revision_commit_match check (revision = commit_sha),
  constraint repository_snapshots_branch_non_empty check (branch is null or btrim(branch) <> ''),
  constraint repository_snapshots_status_valid check (status in ('building', 'published', 'failed', 'superseded')),
  constraint repository_snapshots_counts_valid check (
    chunk_count >= 0 and file_count >= 0 and symbol_count >= 0
    and graph_node_count >= 0 and graph_edge_count >= 0
  ),
  constraint repository_snapshots_indexed_at_consistent check ((status = 'published') = (indexed_at is not null))
);

create unique index if not exists repository_snapshots_one_published_idx
  on public.repository_snapshots (repository_id) where status = 'published';
create index if not exists repository_snapshots_job_idx
  on public.repository_snapshots (job_id);
create index if not exists repository_snapshots_cleanup_idx
  on public.repository_snapshots (repository_id, status, updated_at);

create or replace function public.begin_repository_snapshot(
  input_repository_id text,
  input_revision text,
  input_branch text,
  input_job_id text,
  input_worker_id text
)
returns table (
  already_published boolean,
  chunk_count integer,
  file_count integer,
  symbol_count integer,
  graph_node_count integer,
  graph_edge_count integer,
  summary_available boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  repository_row public.repositories%rowtype;
  job_row public.indexing_jobs%rowtype;
begin
  if input_revision is null or input_revision !~ '^[0-9a-f]{40}$' then
    raise check_violation using message = 'repository revision must be a full lowercase commit SHA';
  end if;

  select * into repository_row from public.repositories
  where repository_id = input_repository_id for update;
  if not found then raise foreign_key_violation using message = 'repository does not exist'; end if;

  select * into job_row from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and status = 'running'
  for update;
  if not found then raise check_violation using message = 'indexing job cannot stage this snapshot'; end if;

  if repository_row.indexed_revision = input_revision then
    return query select true, repository_row.chunk_count, repository_row.file_count,
      repository_row.symbol_count, repository_row.graph_node_count,
      repository_row.graph_edge_count, repository_row.metadata_available;
    return;
  end if;

  delete from public.repository_chunks chunks
  using public.repository_snapshots snapshots
  where snapshots.repository_id = input_repository_id
    and snapshots.job_id = input_job_id and snapshots.status = 'building'
    and snapshots.revision <> input_revision
    and chunks.repository = snapshots.repository_id
    and chunks.repository_revision = snapshots.revision;
  delete from public.repository_summaries summaries
  using public.repository_snapshots snapshots
  where snapshots.repository_id = input_repository_id
    and snapshots.job_id = input_job_id and snapshots.status = 'building'
    and snapshots.revision <> input_revision
    and summaries.repository = snapshots.repository_id
    and summaries.repository_revision = snapshots.revision;
  update public.repository_snapshots set status = 'failed', updated_at = now()
  where repository_id = input_repository_id and job_id = input_job_id
    and status = 'building' and revision <> input_revision;

  insert into public.repository_snapshots (
    repository_id, revision, commit_sha, branch, job_id, status, updated_at
  ) values (
    input_repository_id, input_revision, input_revision, input_branch,
    input_job_id, 'building', now()
  )
  on conflict (repository_id, revision) do update set
    branch = excluded.branch,
    job_id = excluded.job_id,
    status = 'building',
    indexed_at = null,
    updated_at = now()
  where repository_snapshots.status in ('failed', 'superseded');

  if not exists (
    select 1 from public.repository_snapshots
    where repository_id = input_repository_id and revision = input_revision
      and job_id = input_job_id and status = 'building'
  ) then
    raise check_violation using message = 'repository revision is already being built';
  end if;

  return query select false, 0, 0, 0, 0, 0, false;
end;
$$;

create or replace function public.publish_repository_snapshot(
  input_repository_id text,
  input_revision text,
  input_branch text,
  input_job_id text,
  input_worker_id text,
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
  repository_row public.repositories%rowtype;
  actual_chunk_count bigint;
  published_at timestamptz := now();
begin
  select * into repository_row from public.repositories
  where repository_id = input_repository_id for update;
  if not found then raise foreign_key_violation using message = 'repository does not exist'; end if;

  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and status = 'running'
  for update;
  if not found then raise check_violation using message = 'indexing job cannot publish this snapshot'; end if;

  if repository_row.indexed_revision <> input_revision then
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
    ) then
      raise check_violation using message = 'repository snapshot summary is missing';
    end if;

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
      indexed_at = published_at,
      first_indexed_at = coalesce(first_indexed_at, published_at),
      last_indexed_at = published_at,
      indexing_mode = input_index_mode,
      last_changed_file_count = input_changed_file_count,
      chunk_count = input_chunk_count, file_count = input_file_count,
      symbol_count = input_symbol_count, graph_node_count = input_graph_node_count,
      graph_edge_count = input_graph_edge_count,
      metadata_available = input_summary_available,
      total_indexed_files = input_file_count,
      updated_at = published_at
    where repository_id = input_repository_id;

    delete from public.repository_chunks
    where repository = input_repository_id and repository_revision <> input_revision;
    delete from public.repository_summaries
    where repository = input_repository_id and repository_revision <> input_revision;
  end if;

  update public.indexing_jobs set
    status = 'succeeded', progress = 100, current_stage = 'complete'
  where job_id = input_job_id and status = 'running' and claimed_by = input_worker_id;
  if not found then raise check_violation using message = 'indexing job publication did not complete'; end if;
end;
$$;

create or replace function public.discard_repository_snapshot(
  input_repository_id text,
  input_revision text,
  input_job_id text,
  input_worker_id text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and status in ('claimed', 'running', 'failed')
  for update;
  if not found then raise check_violation using message = 'indexing job cannot discard this snapshot'; end if;

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

create or replace function public.match_repository_chunks(
  input_repository text,
  query_embedding extensions.vector(1536),
  match_count integer,
  input_repository_revision text
)
returns table (
  id text, repository text, repository_revision text, file_path text,
  language text, content text, summary text, start_line integer,
  end_line integer, chunk_index integer, similarity double precision
)
language plpgsql stable security invoker
set search_path = public, extensions
as $$
begin
  if input_repository is null or btrim(input_repository) = '' then
    raise exception 'input_repository is required' using errcode = '22023';
  end if;
  if input_repository_revision is null or btrim(input_repository_revision) = '' then
    raise exception 'published repository revision is required' using errcode = '22023';
  end if;
  if match_count < 1 or match_count > 50 then
    raise exception 'match_count must be between 1 and 50' using errcode = '22023';
  end if;
  return query
  select chunks.id, chunks.repository, chunks.repository_revision,
    chunks.file_path, chunks.language, chunks.content, chunks.summary,
    chunks.start_line, chunks.end_line, chunks.chunk_index,
    (1 - (chunks.embedding <=> query_embedding))::double precision
  from public.repository_chunks chunks
  join public.repositories repositories
    on repositories.repository_id = chunks.repository
    and repositories.indexed_revision = input_repository_revision
  where chunks.repository = input_repository
    and chunks.repository_revision = input_repository_revision
  order by chunks.embedding <=> query_embedding, chunks.file_path,
    chunks.start_line, chunks.chunk_index, chunks.id
  limit match_count;
end;
$$;

alter table public.repository_snapshots enable row level security;
revoke all on table public.repository_snapshots from public, anon, authenticated;
revoke all on function public.begin_repository_snapshot(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.publish_repository_snapshot(text, text, text, text, text, integer, integer, integer, integer, integer, boolean, text, integer) from public, anon, authenticated;
revoke all on function public.discard_repository_snapshot(text, text, text, text) from public, anon, authenticated;
revoke all on function public.match_repository_chunks(text, extensions.vector, integer, text) from public, anon, authenticated;
grant all on table public.repository_snapshots to service_role;
grant execute on function public.begin_repository_snapshot(text, text, text, text, text) to service_role;
grant execute on function public.publish_repository_snapshot(text, text, text, text, text, integer, integer, integer, integer, integer, boolean, text, integer) to service_role;
grant execute on function public.discard_repository_snapshot(text, text, text, text) to service_role;
grant execute on function public.match_repository_chunks(text, extensions.vector, integer, text) to service_role;

comment on function public.publish_repository_snapshot(text, text, text, text, text, integer, integer, integer, integer, integer, boolean, text, integer) is
  'Atomically publishes one immutable commit, completes its job, and removes older retrieval snapshots.';
