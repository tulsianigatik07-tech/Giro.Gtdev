-- PostgreSQL's NULL comparison made the first immutable revision publication
-- take the idempotent replay branch. Preserve the established RPC contract while
-- treating an absent current revision as distinct from the staged revision.
create or replace function public.publish_repository_snapshot(
  input_repository_id text, input_revision text, input_branch text,
  input_job_id text, input_worker_id text, input_claim_token text,
  input_chunk_count integer, input_file_count integer, input_symbol_count integer,
  input_graph_node_count integer, input_graph_edge_count integer,
  input_summary_available boolean, input_index_mode text, input_changed_file_count integer
)
returns void language plpgsql security invoker set search_path = public as $$
declare
  actual_chunk_count bigint;
  published_at timestamptz := now();
  repository_row public.repositories%rowtype;
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and status = 'running' and lease_expires_at > published_at
  for update;
  if not found then
    raise serialization_failure using message = 'indexing_job_lease_conflict';
  end if;

  select * into repository_row
  from public.repositories
  where repository_id = input_repository_id
  for update;
  if not found then
    raise foreign_key_violation using message = 'repository does not exist';
  end if;

  if repository_row.current_revision is distinct from input_revision then
    if repository_row.publishing_revision is distinct from input_revision then
      raise serialization_failure using message = 'repository_publication_fence_conflict';
    end if;
    perform 1 from public.repository_snapshots
    where repository_id = input_repository_id
      and revision = input_revision
      and job_id = input_job_id
      and status = 'building'
    for update;
    if not found then
      raise check_violation using message = 'repository snapshot is not ready to publish';
    end if;
    perform 1 from public.repository_artifacts
    where repository_id = input_repository_id
      and repository_revision = input_revision;
    if not found then
      raise check_violation using message = 'repository artifacts are not ready to publish';
    end if;
    select count(*) into actual_chunk_count
    from public.repository_chunks
    where repository = input_repository_id
      and repository_revision = input_revision;
    if actual_chunk_count <> input_chunk_count then
      raise check_violation using message = 'repository snapshot chunk count does not match';
    end if;

    update public.repository_snapshots
    set status = 'superseded', indexed_at = null, updated_at = published_at
    where repository_id = input_repository_id and status = 'published';
    update public.repository_snapshots
    set status = 'published',
        indexed_at = published_at,
        updated_at = published_at,
        branch = input_branch,
        chunk_count = input_chunk_count,
        file_count = input_file_count,
        symbol_count = input_symbol_count,
        graph_node_count = input_graph_node_count,
        graph_edge_count = input_graph_edge_count,
        summary_available = input_summary_available
    where repository_id = input_repository_id
      and revision = input_revision
      and job_id = input_job_id
      and status = 'building';
    update public.repositories
    set status = 'indexed',
        previous_revision = current_revision,
        current_revision = input_revision,
        indexed_revision = input_revision,
        publishing_revision = null,
        indexed_at = published_at,
        first_indexed_at = coalesce(first_indexed_at, published_at),
        last_indexed_at = published_at,
        indexing_mode = input_index_mode,
        last_changed_file_count = input_changed_file_count,
        chunk_count = input_chunk_count,
        file_count = input_file_count,
        symbol_count = input_symbol_count,
        graph_node_count = input_graph_node_count,
        graph_edge_count = input_graph_edge_count,
        metadata_available = input_summary_available,
        total_indexed_files = input_file_count,
        repository_version = repository_version + 1,
        updated_at = published_at
    where repository_id = input_repository_id;
  else
    update public.repositories
    set publishing_revision = null,
        repository_version = repository_version + 1,
        updated_at = published_at
    where repository_id = input_repository_id
      and publishing_revision = input_revision;
  end if;

  update public.indexing_jobs
  set status = 'succeeded', progress = 100, current_stage = 'complete'
  where job_id = input_job_id
    and claimed_by = input_worker_id
    and claim_token = input_claim_token
    and status = 'running'
    and lease_expires_at > published_at;
  if not found then
    raise serialization_failure using message = 'indexing_job_lease_conflict';
  end if;
end;
$$;
