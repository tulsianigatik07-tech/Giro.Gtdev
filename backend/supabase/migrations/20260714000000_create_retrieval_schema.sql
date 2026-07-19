create schema if not exists extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create table if not exists public.repository_chunks (
  id text primary key,
  repository text not null references public.repositories(repository_id) on delete cascade,
  repository_revision text not null default 'unversioned',
  file_path text not null,
  language text not null,
  chunk_index integer not null,
  content text not null,
  summary text,
  start_line integer not null,
  end_line integer not null,
  content_hash text not null,
  token_count integer not null,
  character_count integer not null,
  embedding extensions.vector(1536) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.repository_chunks
  alter column id type text using id::text,
  add column if not exists repository_revision text not null default 'unversioned',
  add column if not exists content_hash text,
  add column if not exists token_count integer,
  add column if not exists character_count integer,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

update public.repository_chunks
set content_hash = md5(content),
    token_count = greatest(1, ceil(length(content)::numeric / 4)::integer),
    character_count = length(content)
where content_hash is null or token_count is null or character_count is null;

alter table public.repository_chunks
  alter column content_hash set not null,
  alter column token_count set not null,
  alter column character_count set not null;

alter table public.repository_chunks
  drop constraint if exists repository_chunks_repository_fkey,
  add constraint repository_chunks_repository_fkey
    foreign key (repository) references public.repositories(repository_id) on delete cascade,
  drop constraint if exists repository_chunks_repository_non_empty,
  add constraint repository_chunks_repository_non_empty check (btrim(repository) <> ''),
  drop constraint if exists repository_chunks_revision_non_empty,
  add constraint repository_chunks_revision_non_empty check (btrim(repository_revision) <> ''),
  drop constraint if exists repository_chunks_file_path_valid,
  add constraint repository_chunks_file_path_valid check (
    btrim(file_path) <> '' and file_path !~ '(^|/)\.\.(/|$)' and file_path !~ '^/'
  ),
  drop constraint if exists repository_chunks_chunk_index_non_negative,
  add constraint repository_chunks_chunk_index_non_negative check (chunk_index >= 0),
  drop constraint if exists repository_chunks_line_range_valid,
  add constraint repository_chunks_line_range_valid check (start_line >= 1 and end_line >= start_line),
  drop constraint if exists repository_chunks_content_non_empty,
  add constraint repository_chunks_content_non_empty check (length(content) > 0),
  drop constraint if exists repository_chunks_token_count_positive,
  add constraint repository_chunks_token_count_positive check (token_count > 0),
  drop constraint if exists repository_chunks_character_count_positive,
  add constraint repository_chunks_character_count_positive check (character_count > 0),
  drop constraint if exists repository_chunks_metadata_object,
  add constraint repository_chunks_metadata_object check (jsonb_typeof(metadata) = 'object');

create unique index if not exists repository_chunks_snapshot_position_uidx
  on public.repository_chunks (repository, repository_revision, file_path, chunk_index);
create unique index if not exists repository_chunks_snapshot_content_uidx
  on public.repository_chunks (repository, repository_revision, file_path, content_hash, start_line, end_line);
create index if not exists repository_chunks_repository_revision_idx
  on public.repository_chunks (repository, repository_revision);
create index if not exists repository_chunks_repository_file_idx
  on public.repository_chunks (repository, file_path, chunk_index);
create index if not exists repository_chunks_content_trgm_idx
  on public.repository_chunks using gin (content extensions.gin_trgm_ops);
create index if not exists repository_chunks_file_path_trgm_idx
  on public.repository_chunks using gin (file_path extensions.gin_trgm_ops);
create index if not exists repository_chunks_embedding_hnsw_idx
  on public.repository_chunks using hnsw (embedding extensions.vector_cosine_ops);

create table if not exists public.repository_summaries (
  repository text not null references public.repositories(repository_id) on delete cascade,
  repository_revision text not null default 'unversioned',
  summary_kind text not null default 'intelligence',
  summary jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (repository, repository_revision, summary_kind)
);

alter table public.repository_summaries
  add column if not exists repository_revision text not null default 'unversioned',
  add column if not exists summary_kind text not null default 'intelligence',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table public.repository_summaries
  drop constraint if exists repository_summaries_pkey,
  drop constraint if exists repository_summaries_repository_key,
  add constraint repository_summaries_pkey
    primary key (repository, repository_revision, summary_kind);

alter table public.repository_summaries
  drop constraint if exists repository_summaries_repository_fkey,
  add constraint repository_summaries_repository_fkey
    foreign key (repository) references public.repositories(repository_id) on delete cascade,
  drop constraint if exists repository_summaries_repository_non_empty,
  add constraint repository_summaries_repository_non_empty check (btrim(repository) <> ''),
  drop constraint if exists repository_summaries_revision_non_empty,
  add constraint repository_summaries_revision_non_empty check (btrim(repository_revision) <> ''),
  drop constraint if exists repository_summaries_kind_valid,
  add constraint repository_summaries_kind_valid check (summary_kind in ('intelligence', 'architecture')),
  drop constraint if exists repository_summaries_summary_object,
  add constraint repository_summaries_summary_object check (jsonb_typeof(summary) = 'object');

create unique index if not exists repository_summaries_scope_uidx
  on public.repository_summaries (repository, repository_revision, summary_kind);
create index if not exists repository_summaries_repository_updated_idx
  on public.repository_summaries (repository, updated_at desc);

create or replace function public.match_repository_chunks(
  input_repository text,
  query_embedding extensions.vector(1536),
  match_count integer,
  input_repository_revision text default null
)
returns table (
  id text,
  repository text,
  repository_revision text,
  file_path text,
  language text,
  content text,
  summary text,
  start_line integer,
  end_line integer,
  chunk_index integer,
  similarity double precision
)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
begin
  if input_repository is null or btrim(input_repository) = '' then
    raise exception 'input_repository is required' using errcode = '22023';
  end if;
  if match_count < 1 or match_count > 50 then
    raise exception 'match_count must be between 1 and 50' using errcode = '22023';
  end if;

  return query
  select
    chunks.id,
    chunks.repository,
    chunks.repository_revision,
    chunks.file_path,
    chunks.language,
    chunks.content,
    chunks.summary,
    chunks.start_line,
    chunks.end_line,
    chunks.chunk_index,
    (1 - (chunks.embedding <=> query_embedding))::double precision as similarity
  from public.repository_chunks as chunks
  join public.repositories as repositories
    on repositories.repository_id = chunks.repository
  where chunks.repository = input_repository
    and (
      input_repository_revision is not null
        and chunks.repository_revision = input_repository_revision
      or input_repository_revision is null
        and (repositories.indexed_revision is null or chunks.repository_revision = repositories.indexed_revision)
    )
  order by
    chunks.embedding <=> query_embedding asc,
    chunks.file_path asc,
    chunks.start_line asc,
    chunks.chunk_index asc,
    chunks.id asc
  limit match_count;
end;
$$;

create or replace function public.delete_repository_retrieval_data(
  input_repository text,
  input_keep_revision text default null
)
returns table (deleted_chunks bigint, deleted_summaries bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  chunk_count bigint;
  summary_count bigint;
begin
  delete from public.repository_chunks
  where repository = input_repository
    and (input_keep_revision is null or repository_revision <> input_keep_revision);
  get diagnostics chunk_count = row_count;

  delete from public.repository_summaries
  where repository = input_repository
    and (input_keep_revision is null or repository_revision <> input_keep_revision);
  get diagnostics summary_count = row_count;

  return query select chunk_count, summary_count;
end;
$$;

alter table public.repository_chunks enable row level security;
alter table public.repository_summaries enable row level security;
revoke all on table public.repository_chunks from anon, authenticated;
revoke all on table public.repository_summaries from anon, authenticated;
revoke all on function public.match_repository_chunks(text, extensions.vector, integer, text) from public, anon, authenticated;
revoke all on function public.delete_repository_retrieval_data(text, text) from public, anon, authenticated;
grant all on table public.repository_chunks to service_role;
grant all on table public.repository_summaries to service_role;
grant execute on function public.match_repository_chunks(text, extensions.vector, integer, text) to service_role;
grant execute on function public.delete_repository_retrieval_data(text, text) to service_role;
