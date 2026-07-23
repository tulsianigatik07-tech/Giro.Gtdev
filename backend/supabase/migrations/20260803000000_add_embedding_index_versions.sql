create table if not exists public.embedding_index_versions (
  embedding_version text primary key,
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  repository_revision text not null,
  embedding_provider text not null,
  embedding_model text not null,
  embedding_dimension integer not null,
  chunking_strategy_version text not null,
  job_id text references public.indexing_jobs(job_id) on delete set null,
  status text not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint embedding_index_versions_identity_unique
    unique (embedding_version, repository_id, repository_revision),
  constraint embedding_index_versions_repository_revision_fkey
    foreign key (repository_id, repository_revision)
    references public.repository_snapshots(repository_id, revision) on delete cascade,
  constraint embedding_index_versions_repository_configuration_unique
    unique (
      repository_id, repository_revision, embedding_provider, embedding_model,
      embedding_dimension, chunking_strategy_version
    ),
  constraint embedding_index_versions_status_valid
    check (status in ('building', 'validating', 'published', 'failed', 'superseded')),
  constraint embedding_index_versions_dimension_valid check (embedding_dimension > 0),
  constraint embedding_index_versions_metadata_present check (
    btrim(embedding_version) <> '' and btrim(repository_revision) <> ''
    and btrim(embedding_provider) <> '' and btrim(embedding_model) <> ''
    and btrim(chunking_strategy_version) <> ''
  ),
  constraint embedding_index_versions_publication_timestamp check (
    (status = 'published' and published_at is not null)
    or (status <> 'published')
  )
);

create table if not exists public.embedding_index_validations (
  embedding_version text primary key
    references public.embedding_index_versions(embedding_version) on delete cascade,
  expected_vector_count integer not null,
  vector_count integer not null,
  orphan_vector_count integer not null,
  duplicate_chunk_hash_count integer not null,
  missing_metadata_count integer not null,
  dimension_mismatch_count integer not null,
  is_valid boolean not null,
  validated_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb,
  constraint embedding_index_validations_counts_valid check (
    expected_vector_count >= 0 and vector_count >= 0 and orphan_vector_count >= 0
    and duplicate_chunk_hash_count >= 0 and missing_metadata_count >= 0
    and dimension_mismatch_count >= 0
  ),
  constraint embedding_index_validations_details_object
    check (jsonb_typeof(details) = 'object'),
  constraint embedding_index_validations_result_consistent check (
    not is_valid or (
      vector_count = expected_vector_count
      and orphan_vector_count = 0
      and duplicate_chunk_hash_count = 0
      and missing_metadata_count = 0
      and dimension_mismatch_count = 0
    )
  )
);

create table if not exists public.embedding_index_publications (
  repository_id text primary key references public.repositories(repository_id) on delete cascade,
  repository_revision text not null,
  embedding_version text not null unique,
  published_at timestamptz not null,
  constraint embedding_index_publications_version_identity_fkey
    foreign key (embedding_version, repository_id, repository_revision)
    references public.embedding_index_versions(
      embedding_version, repository_id, repository_revision
    ) on delete restrict
);

create index if not exists embedding_index_versions_repository_status_idx
  on public.embedding_index_versions(repository_id, status, published_at desc);
create index if not exists embedding_index_versions_cleanup_idx
  on public.embedding_index_versions(status, updated_at)
  where status in ('building', 'validating', 'failed', 'superseded');
create index if not exists embedding_index_publications_revision_idx
  on public.embedding_index_publications(repository_id, repository_revision);

create or replace function public.enforce_embedding_version_identity_immutability()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.embedding_version is distinct from old.embedding_version
    or new.repository_id is distinct from old.repository_id
    or new.repository_revision is distinct from old.repository_revision
    or new.embedding_provider is distinct from old.embedding_provider
    or new.embedding_model is distinct from old.embedding_model
    or new.embedding_dimension is distinct from old.embedding_dimension
    or new.chunking_strategy_version is distinct from old.chunking_strategy_version
    or new.created_at is distinct from old.created_at then
    raise check_violation using message = 'embedding index version identity is immutable';
  end if;
  return new;
end; $$;

drop trigger if exists embedding_index_versions_immutable_identity_trigger
  on public.embedding_index_versions;
create trigger embedding_index_versions_immutable_identity_trigger
before update on public.embedding_index_versions
for each row execute function public.enforce_embedding_version_identity_immutability();

alter table public.repository_chunks
  add column if not exists embedding_version text,
  add column if not exists chunk_id text,
  add column if not exists chunk_hash text;

insert into public.embedding_index_versions (
  embedding_version, repository_id, repository_revision, embedding_provider,
  embedding_model, embedding_dimension, chunking_strategy_version, status,
  created_at, published_at, updated_at
)
select
  'legacy-' || md5(chunks.repository || ':' || chunks.repository_revision),
  chunks.repository,
  chunks.repository_revision,
  'legacy',
  'legacy',
  1536,
  'legacy',
  case when repositories.current_revision = chunks.repository_revision
    then 'published' else 'superseded' end,
  min(chunks.created_at),
  case when repositories.current_revision = chunks.repository_revision
    then coalesce(repositories.indexed_at, min(chunks.created_at)) else null end,
  now()
from public.repository_chunks chunks
join public.repositories repositories on repositories.repository_id = chunks.repository
where chunks.embedding_version is null
group by chunks.repository, chunks.repository_revision, repositories.current_revision,
  repositories.indexed_at
on conflict do nothing;

update public.repository_chunks chunks
set embedding_version =
      'legacy-' || md5(chunks.repository || ':' || chunks.repository_revision),
    chunk_id = coalesce(chunks.chunk_id, chunks.file_path || ':' || chunks.start_line || '-' || chunks.end_line),
    chunk_hash = coalesce(
      chunks.chunk_hash,
      md5(chunks.file_path || ':' || chunks.start_line::text || ':' || chunks.content)
    )
where chunks.embedding_version is null or chunks.chunk_id is null or chunks.chunk_hash is null;

insert into public.embedding_index_validations (
  embedding_version, expected_vector_count, vector_count, orphan_vector_count,
  duplicate_chunk_hash_count, missing_metadata_count, dimension_mismatch_count,
  is_valid, validated_at, details
)
select versions.embedding_version, count(chunks.id), count(chunks.id), 0, 0, 0, 0,
  true, now(), '{"source":"migration"}'::jsonb
from public.embedding_index_versions versions
join public.repository_chunks chunks
  on chunks.embedding_version = versions.embedding_version
where versions.embedding_provider = 'legacy'
group by versions.embedding_version
on conflict (embedding_version) do nothing;

insert into public.embedding_index_publications (
  repository_id, repository_revision, embedding_version, published_at
)
select versions.repository_id, versions.repository_revision, versions.embedding_version,
  versions.published_at
from public.embedding_index_versions versions
where versions.status = 'published'
on conflict (repository_id) do nothing;

alter table public.repository_chunks
  alter column embedding_version set not null,
  alter column chunk_id set not null,
  alter column chunk_hash set not null,
  drop constraint if exists repository_chunks_embedding_version_identity_fkey,
  add constraint repository_chunks_embedding_version_identity_fkey
    foreign key (embedding_version, repository, repository_revision)
    references public.embedding_index_versions(
      embedding_version, repository_id, repository_revision
    ) on delete cascade,
  drop constraint if exists repository_chunks_chunk_metadata_present,
  add constraint repository_chunks_chunk_metadata_present check (
    btrim(chunk_id) <> '' and btrim(chunk_hash) <> ''
  );

drop index if exists public.repository_chunks_snapshot_position_uidx;
drop index if exists public.repository_chunks_snapshot_content_uidx;
create unique index repository_chunks_embedding_chunk_uidx
  on public.repository_chunks(embedding_version, chunk_id);
create unique index repository_chunks_embedding_position_uidx
  on public.repository_chunks(embedding_version, file_path, chunk_index);
create index repository_chunks_embedding_version_idx
  on public.repository_chunks(embedding_version);
create index repository_chunks_cleanup_idx
  on public.repository_chunks(repository, repository_revision, embedding_version);

create or replace function public.enforce_embedding_chunk_immutability()
returns trigger language plpgsql security invoker set search_path = public as $$
declare version_status text;
begin
  if tg_op = 'DELETE' then
    select status into version_status
    from public.embedding_index_versions
    where embedding_version = old.embedding_version;
  else
    select status into version_status
    from public.embedding_index_versions
    where embedding_version = new.embedding_version;
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from public.repositories repositories
    where repositories.repository_id = old.repository
      and repositories.deletion_state = 'deleting'
  ) then
    return old;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and version_status <> 'building' then
    raise check_violation using message = 'embedding index is immutable';
  end if;
  if tg_op = 'DELETE' and version_status not in ('building', 'validating', 'failed', 'superseded') then
    raise check_violation using message = 'published embedding index is immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end; $$;

drop trigger if exists repository_chunks_immutable_version_trigger on public.repository_chunks;
create trigger repository_chunks_immutable_version_trigger
before insert or update or delete on public.repository_chunks
for each row execute function public.enforce_embedding_chunk_immutability();

create or replace function public.begin_embedding_index_version(
  input_repository_id text,
  input_repository_revision text,
  input_embedding_provider text,
  input_embedding_model text,
  input_embedding_dimension integer,
  input_embedding_version text,
  input_chunking_strategy_version text,
  input_job_id text,
  input_worker_id text,
  input_claim_token text
)
returns table(already_published boolean)
language plpgsql security invoker set search_path = public, extensions as $$
declare existing public.embedding_index_versions%rowtype;
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and status = 'running' and lease_expires_at > now()
  for update;
  if not found then
    raise serialization_failure using message = 'indexing_job_lease_conflict';
  end if;
  if input_embedding_dimension < 1 then
    raise check_violation using message = 'embedding dimension must be positive';
  end if;

  select * into existing
  from public.embedding_index_versions
  where embedding_version = input_embedding_version
  for update;

  if found then
    if existing.repository_id is distinct from input_repository_id
      or existing.repository_revision is distinct from input_repository_revision
      or existing.embedding_provider is distinct from input_embedding_provider
      or existing.embedding_model is distinct from input_embedding_model
      or existing.embedding_dimension is distinct from input_embedding_dimension
      or existing.chunking_strategy_version is distinct from input_chunking_strategy_version then
      raise check_violation using message = 'embedding version configuration mismatch';
    end if;
    if existing.status = 'published'
      and exists (
        select 1 from public.embedding_index_publications publications
        join public.embedding_index_validations validations
          on validations.embedding_version = publications.embedding_version
        where publications.repository_id = input_repository_id
          and publications.repository_revision = input_repository_revision
          and publications.embedding_version = input_embedding_version
          and validations.is_valid
      ) then
      return query select true;
      return;
    end if;
    if existing.status in ('building', 'validating') and existing.job_id <> input_job_id then
      raise serialization_failure using message = 'embedding_index_publication_in_progress';
    end if;
    if existing.status in ('failed', 'superseded') then
      delete from public.repository_chunks
      where embedding_version = input_embedding_version;
    end if;
    update public.embedding_index_versions
    set status = 'building', job_id = input_job_id, published_at = null, updated_at = now()
    where embedding_version = input_embedding_version;
    delete from public.embedding_index_validations
    where embedding_version = input_embedding_version;
  else
    insert into public.embedding_index_versions (
      embedding_version, repository_id, repository_revision, embedding_provider,
      embedding_model, embedding_dimension, chunking_strategy_version, job_id, status
    ) values (
      input_embedding_version, input_repository_id, input_repository_revision,
      input_embedding_provider, input_embedding_model, input_embedding_dimension,
      input_chunking_strategy_version, input_job_id, 'building'
    );
  end if;
  return query select false;
end; $$;

create or replace function public.validate_embedding_index_version(
  input_repository_id text,
  input_repository_revision text,
  input_embedding_version text,
  input_expected_vector_count integer,
  input_job_id text,
  input_worker_id text,
  input_claim_token text
)
returns table (
  expected_vector_count integer,
  vector_count integer,
  orphan_vector_count integer,
  duplicate_chunk_hash_count integer,
  missing_metadata_count integer,
  dimension_mismatch_count integer,
  is_valid boolean
)
language plpgsql security invoker set search_path = public, extensions as $$
declare
  version_row public.embedding_index_versions%rowtype;
  actual_vectors integer;
  orphan_vectors integer;
  duplicate_hashes integer;
  missing_metadata integer;
  wrong_dimensions integer;
  validation_valid boolean;
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and status = 'running' and lease_expires_at > now()
  for update;
  if not found then
    raise serialization_failure using message = 'indexing_job_lease_conflict';
  end if;

  select * into version_row from public.embedding_index_versions
  where embedding_version = input_embedding_version
    and repository_id = input_repository_id
    and repository_revision = input_repository_revision
    and job_id = input_job_id
    and status = 'building'
  for update;
  if not found then
    raise check_violation using message = 'embedding index is not ready for validation';
  end if;
  update public.embedding_index_versions
  set status = 'validating', updated_at = now()
  where embedding_version = input_embedding_version;

  select count(*) into actual_vectors
  from public.repository_chunks
  where embedding_version = input_embedding_version;

  select count(*) into orphan_vectors
  from public.repository_chunks chunks
  left join public.embedding_index_versions versions
    on versions.embedding_version = chunks.embedding_version
      and versions.repository_id = chunks.repository
      and versions.repository_revision = chunks.repository_revision
  where chunks.embedding_version = input_embedding_version
    and versions.embedding_version is null;

  select coalesce(sum(duplicates - 1), 0)::integer into duplicate_hashes
  from (
    select count(*) as duplicates
    from public.repository_chunks
    where embedding_version = input_embedding_version
    group by chunk_hash
    having count(*) > 1
  ) duplicate_groups;

  select count(*) into missing_metadata
  from public.repository_chunks
  where embedding_version = input_embedding_version
    and (
      file_path is null or btrim(file_path) = ''
      or chunk_id is null or btrim(chunk_id) = ''
      or chunk_hash is null or btrim(chunk_hash) = ''
      or repository_revision is null or btrim(repository_revision) = ''
      or embedding_version is null or btrim(embedding_version) = ''
    );

  select count(*) into wrong_dimensions
  from public.repository_chunks
  where embedding_version = input_embedding_version
    and vector_dims(embedding) <> version_row.embedding_dimension;

  validation_valid := input_expected_vector_count >= 0
    and actual_vectors = input_expected_vector_count
    and orphan_vectors = 0
    and duplicate_hashes = 0
    and missing_metadata = 0
    and wrong_dimensions = 0;

  insert into public.embedding_index_validations (
    embedding_version, expected_vector_count, vector_count, orphan_vector_count,
    duplicate_chunk_hash_count, missing_metadata_count, dimension_mismatch_count,
    is_valid, validated_at, details
  ) values (
    input_embedding_version, input_expected_vector_count, actual_vectors,
    orphan_vectors, duplicate_hashes, missing_metadata, wrong_dimensions,
    validation_valid, now(), jsonb_build_object('job_id', input_job_id)
  )
  on conflict (embedding_version) do update set
    expected_vector_count = excluded.expected_vector_count,
    vector_count = excluded.vector_count,
    orphan_vector_count = excluded.orphan_vector_count,
    duplicate_chunk_hash_count = excluded.duplicate_chunk_hash_count,
    missing_metadata_count = excluded.missing_metadata_count,
    dimension_mismatch_count = excluded.dimension_mismatch_count,
    is_valid = excluded.is_valid,
    validated_at = excluded.validated_at,
    details = excluded.details;

  if not validation_valid then
    update public.embedding_index_versions
    set status = 'failed', updated_at = now()
    where embedding_version = input_embedding_version;
  end if;

  return query select input_expected_vector_count, actual_vectors, orphan_vectors,
    duplicate_hashes, missing_metadata, wrong_dimensions, validation_valid;
end; $$;

create or replace function public.discard_embedding_index_version(
  input_repository_id text,
  input_repository_revision text,
  input_embedding_version text,
  input_job_id text,
  input_worker_id text,
  input_claim_token text
)
returns void language plpgsql security invoker set search_path = public as $$
begin
  perform 1 from public.indexing_jobs
  where job_id = input_job_id and repository_id = input_repository_id
    and claimed_by = input_worker_id and claim_token = input_claim_token
    and ((status in ('claimed', 'running') and lease_expires_at > now()) or status = 'failed')
  for update;
  if not found then
    raise serialization_failure using message = 'indexing_job_lease_conflict';
  end if;
  update public.embedding_index_versions
  set status = 'failed', published_at = null, updated_at = now()
  where embedding_version = input_embedding_version
    and repository_id = input_repository_id
    and repository_revision = input_repository_revision
    and job_id = input_job_id
    and status in ('building', 'validating', 'failed');
  delete from public.repository_chunks
  where embedding_version = input_embedding_version
    and exists (
      select 1 from public.embedding_index_versions versions
      where versions.embedding_version = input_embedding_version
        and versions.status = 'failed'
    );
end; $$;

create or replace function public.recover_embedding_index_versions()
returns table(cleaned_version_count bigint)
language plpgsql security invoker set search_path = public as $$
declare cleaned bigint;
begin
  with abandoned as (
    update public.embedding_index_versions versions
    set status = 'failed', published_at = null, updated_at = now()
    where versions.status in ('building', 'validating')
      and not exists (
        select 1 from public.indexing_jobs jobs
        where jobs.job_id = versions.job_id
          and jobs.status in ('claimed', 'running')
          and jobs.lease_expires_at > now()
      )
    returning versions.embedding_version
  ), removed as (
    delete from public.repository_chunks chunks
    using abandoned
    where chunks.embedding_version = abandoned.embedding_version
    returning chunks.embedding_version
  )
  select count(distinct embedding_version) into cleaned from removed;
  return query select coalesce(cleaned, 0);
end; $$;

create or replace function public.verify_embedding_index_contract()
returns table(valid boolean)
language plpgsql stable security invoker set search_path = public, extensions, pg_catalog as $$
declare vector_extension_version text;
begin
  select extversion into vector_extension_version
  from pg_catalog.pg_extension where extname = 'vector';
  if vector_extension_version is null then
    raise exception 'pgvector extension is not installed' using errcode = '42704';
  end if;
  if vector_extension_version !~ '^[0-9]+\.[0-9]+'
    or split_part(vector_extension_version, '.', 1)::integer < 0
    or (
      split_part(vector_extension_version, '.', 1)::integer = 0
      and split_part(vector_extension_version, '.', 2)::integer < 5
    ) then
    raise exception 'pgvector 0.5 or newer is required' using errcode = '0A000';
  end if;
  if to_regclass('public.embedding_index_versions') is null
    or to_regclass('public.embedding_index_validations') is null
    or to_regclass('public.embedding_index_publications') is null
    or to_regclass('public.repository_chunks_embedding_hnsw_idx') is null then
    raise exception 'embedding index database objects are missing' using errcode = '42P01';
  end if;
  if exists (
    select 1 from public.repository_chunks chunks
    join public.embedding_index_versions versions
      on versions.embedding_version = chunks.embedding_version
    where vector_dims(chunks.embedding) <> versions.embedding_dimension
  ) then
    raise check_violation using message = 'embedding vector dimensions are inconsistent';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_attribute attributes
    where attributes.attrelid = 'public.repository_chunks'::regclass
      and attributes.attname = 'embedding'
      and pg_catalog.format_type(attributes.atttypid, attributes.atttypmod) = 'vector(1536)'
      and not attributes.attisdropped
  ) then
    raise check_violation using message = 'embedding vector column dimension is invalid';
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_index indexes
    join pg_catalog.pg_class index_class on index_class.oid = indexes.indexrelid
    join pg_catalog.pg_am access_method on access_method.oid = index_class.relam
    join pg_catalog.pg_opclass operator_class on operator_class.oid = indexes.indclass[0]
    where indexes.indrelid = 'public.repository_chunks'::regclass
      and index_class.relname = 'repository_chunks_embedding_hnsw_idx'
      and access_method.amname = 'hnsw'
      and operator_class.opcname = 'vector_cosine_ops'
  ) then
    raise check_violation using message = 'embedding vector index is incompatible';
  end if;
  if exists (
    select 1
    from public.embedding_index_publications publications
    join public.repositories repositories
      on repositories.repository_id = publications.repository_id
    left join public.embedding_index_versions versions
      on versions.embedding_version = publications.embedding_version
    left join public.embedding_index_validations validations
      on validations.embedding_version = publications.embedding_version
    where repositories.current_revision is distinct from publications.repository_revision
      or versions.status is distinct from 'published'
      or validations.is_valid is distinct from true
  ) then
    raise check_violation using message = 'embedding publication contract is inconsistent';
  end if;
  if (
    select count(*) from pg_catalog.pg_constraint
    where (
      conrelid = 'public.repository_chunks'::regclass
      and conname in (
        'repository_chunks_embedding_version_identity_fkey',
        'repository_chunks_chunk_metadata_present'
      )
    ) or (
      conrelid = 'public.embedding_index_versions'::regclass
      and conname in (
        'embedding_index_versions_status_valid',
        'embedding_index_versions_publication_timestamp'
      )
    )
  ) <> 4 then
    raise check_violation using message = 'embedding index constraints are missing';
  end if;
  return query select true;
end; $$;

create or replace view public.published_repository_chunks
with (security_invoker = true)
as
select chunks.*
from public.repository_chunks chunks
join public.embedding_index_publications publications
  on publications.repository_id = chunks.repository
  and publications.repository_revision = chunks.repository_revision
  and publications.embedding_version = chunks.embedding_version
join public.embedding_index_versions versions
  on versions.embedding_version = publications.embedding_version
  and versions.status = 'published'
join public.embedding_index_validations validations
  on validations.embedding_version = versions.embedding_version
  and validations.is_valid
join public.repositories repositories
  on repositories.repository_id = publications.repository_id
  and repositories.current_revision = publications.repository_revision;

do $migration$
declare
  existing_function record;
  vector_schema name;
  vector_type_oid oid;
begin
  select namespace.nspname, vector_type.oid
  into vector_schema, vector_type_oid
  from pg_catalog.pg_extension extension
  join pg_catalog.pg_depend dependency
    on dependency.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
    and dependency.refobjid = extension.oid
    and dependency.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
    and dependency.deptype = 'e'
  join pg_catalog.pg_type vector_type
    on vector_type.oid = dependency.objid and vector_type.typname = 'vector'
  join pg_catalog.pg_namespace namespace on namespace.oid = vector_type.typnamespace
  where extension.extname = 'vector';

  for existing_function in
    select proc.oid, pg_catalog.pg_get_function_identity_arguments(proc.oid) identity_arguments
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = 'match_repository_chunks'
      and proc.prokind = 'f'
      and proc.pronargs in (4, 5)
      and proc.proargtypes[0] = 'pg_catalog.text'::pg_catalog.regtype
      and proc.proargtypes[1] = vector_type_oid
      and proc.proargtypes[2] = 'pg_catalog.int4'::pg_catalog.regtype
      and proc.proargtypes[3] = 'pg_catalog.text'::pg_catalog.regtype
      and (proc.pronargs = 4 or proc.proargtypes[4] = 'pg_catalog.text'::pg_catalog.regtype)
  loop
    execute pg_catalog.format(
      'drop function %I.%I(%s)',
      'public', 'match_repository_chunks', existing_function.identity_arguments
    );
  end loop;

  execute pg_catalog.format($function$
    create function public.match_repository_chunks(
      input_repository text,
      query_embedding %I.vector(1536),
      match_count integer,
      input_repository_revision text,
      input_embedding_version text
    )
    returns table (
      id text, repository text, repository_revision text, file_path text,
      language text, content text, summary text, start_line integer,
      end_line integer, chunk_index integer, similarity double precision
    )
    language plpgsql stable security invoker set search_path = pg_catalog, public as $body$
    begin
      if match_count < 1 or match_count > 50 then
        raise exception 'match_count must be between 1 and 50' using errcode = '22023';
      end if;
      if not exists (
        select 1
        from public.embedding_index_publications publications
        join public.embedding_index_versions versions
          on versions.embedding_version = publications.embedding_version
          and versions.status = 'published'
        join public.embedding_index_validations validations
          on validations.embedding_version = publications.embedding_version
          and validations.is_valid
        join public.repositories repositories
          on repositories.repository_id = publications.repository_id
          and repositories.current_revision = publications.repository_revision
        where publications.repository_id = input_repository
          and publications.repository_revision = input_repository_revision
          and publications.embedding_version = input_embedding_version
      ) then
        raise check_violation using message = 'embedding_index_rebuild_required';
      end if;
      return query
      select chunks.id, chunks.repository, chunks.repository_revision,
        chunks.file_path, chunks.language, chunks.content, chunks.summary,
        chunks.start_line, chunks.end_line, chunks.chunk_index,
        (1 - (chunks.embedding OPERATOR(%I.<=>) query_embedding))::double precision
      from public.published_repository_chunks chunks
      where chunks.repository = input_repository
        and chunks.repository_revision = input_repository_revision
        and chunks.embedding_version = input_embedding_version
        and match_count between 1 and 50
      order by chunks.embedding OPERATOR(%I.<=>) query_embedding,
        chunks.file_path, chunks.start_line, chunks.chunk_index, chunks.id
      limit match_count;
    end;
    $body$
  $function$, vector_schema, vector_schema, vector_schema);

  execute pg_catalog.format(
    'revoke all on function public.match_repository_chunks(text, %I.vector(1536), integer, text, text) from public, anon, authenticated',
    vector_schema
  );
  execute pg_catalog.format(
    'grant execute on function public.match_repository_chunks(text, %I.vector(1536), integer, text, text) to service_role',
    vector_schema
  );
end;
$migration$;

create or replace function public.publish_repository_snapshot(
  input_repository_id text, input_revision text, input_branch text,
  input_job_id text, input_worker_id text, input_claim_token text,
  input_chunk_count integer, input_file_count integer, input_symbol_count integer,
  input_graph_node_count integer, input_graph_edge_count integer,
  input_summary_available boolean, input_embedding_version text,
  input_index_mode text, input_changed_file_count integer,
  input_owner_user_id text, input_repository_storage_bytes bigint,
  input_max_indexed_repositories integer, input_max_user_storage_bytes bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  version_row public.embedding_index_versions%rowtype;
  effective_repository_storage_bytes bigint;
begin
  select versions.* into version_row
  from public.embedding_index_versions versions
  join public.embedding_index_validations validations
    on validations.embedding_version = versions.embedding_version
    and validations.is_valid
    and validations.vector_count = input_chunk_count
  where versions.embedding_version = input_embedding_version
    and versions.repository_id = input_repository_id
    and versions.repository_revision = input_revision
    and (
      (versions.status = 'validating' and versions.job_id = input_job_id)
      or (
        versions.status = 'published'
        and exists (
          select 1 from public.embedding_index_publications publications
          where publications.repository_id = input_repository_id
            and publications.repository_revision = input_revision
            and publications.embedding_version = input_embedding_version
        )
      )
    )
  for update of versions;
  if not found then
    raise check_violation using message = 'validated embedding index is required for publication';
  end if;

  update public.embedding_index_versions versions
  set status = 'superseded', published_at = null, updated_at = now()
  where versions.embedding_version = (
    select publications.embedding_version
    from public.embedding_index_publications publications
    where publications.repository_id = input_repository_id
      and publications.embedding_version <> input_embedding_version
  );

  delete from public.repository_chunks chunks
  where chunks.repository = input_repository_id
    and chunks.repository_revision = input_revision
    and chunks.embedding_version <> input_embedding_version
    and exists (
      select 1 from public.embedding_index_versions versions
      where versions.embedding_version = chunks.embedding_version
        and versions.status in ('failed', 'superseded')
    );

  select case
    when repositories.current_revision = input_revision then
      coalesce(usage.storage_bytes, input_repository_storage_bytes)
    else input_repository_storage_bytes
  end into effective_repository_storage_bytes
  from public.repositories repositories
  left join public.repository_quota_usage usage
    on usage.repository_id = repositories.repository_id
  where repositories.repository_id = input_repository_id;

  perform public.publish_repository_snapshot(
    input_repository_id, input_revision, input_branch, input_job_id,
    input_worker_id, input_claim_token, input_chunk_count, input_file_count,
    input_symbol_count, input_graph_node_count, input_graph_edge_count,
    input_summary_available, input_index_mode, input_changed_file_count,
    input_owner_user_id, effective_repository_storage_bytes,
    input_max_indexed_repositories, input_max_user_storage_bytes
  );

  update public.repositories
  set chunk_count = input_chunk_count,
      indexing_mode = input_index_mode,
      last_changed_file_count = input_changed_file_count,
      indexed_at = now(),
      last_indexed_at = now(),
      updated_at = now()
  where repository_id = input_repository_id
    and current_revision = input_revision;
  update public.repository_snapshots
  set chunk_count = input_chunk_count, updated_at = now()
  where repository_id = input_repository_id
    and revision = input_revision
    and status = 'published';

  update public.embedding_index_versions
  set status = 'published', published_at = coalesce(published_at, now()), updated_at = now()
  where embedding_version = input_embedding_version;

  insert into public.embedding_index_publications(
    repository_id, repository_revision, embedding_version, published_at
  ) values (
    input_repository_id, input_revision, input_embedding_version,
    (select published_at from public.embedding_index_versions
      where embedding_version = input_embedding_version)
  )
  on conflict (repository_id) do update set
    repository_revision = excluded.repository_revision,
    embedding_version = excluded.embedding_version,
    published_at = excluded.published_at;
end; $$;

alter table public.embedding_index_versions enable row level security;
alter table public.embedding_index_validations enable row level security;
alter table public.embedding_index_publications enable row level security;

revoke all on table public.embedding_index_versions from public, anon, authenticated;
revoke all on table public.embedding_index_validations from public, anon, authenticated;
revoke all on table public.embedding_index_publications from public, anon, authenticated;
revoke all on table public.published_repository_chunks from public, anon, authenticated;
grant all on table public.embedding_index_versions to service_role;
grant all on table public.embedding_index_validations to service_role;
grant all on table public.embedding_index_publications to service_role;
grant select on table public.published_repository_chunks to service_role;

revoke execute on function public.publish_repository_snapshot(
  text,text,text,text,text,text,integer,integer,integer,integer,integer,
  boolean,text,integer,text,bigint,integer,bigint
) from service_role;
revoke execute on function public.publish_repository_snapshot(
  text,text,text,text,text,text,integer,integer,integer,integer,integer,
  boolean,text,integer
) from service_role;

revoke all on function public.begin_embedding_index_version(
  text,text,text,text,integer,text,text,text,text,text
) from public, anon, authenticated;
revoke all on function public.validate_embedding_index_version(
  text,text,text,integer,text,text,text
) from public, anon, authenticated;
revoke all on function public.discard_embedding_index_version(
  text,text,text,text,text,text
) from public, anon, authenticated;
revoke all on function public.recover_embedding_index_versions()
  from public, anon, authenticated;
revoke all on function public.verify_embedding_index_contract()
  from public, anon, authenticated;
revoke all on function public.publish_repository_snapshot(
  text,text,text,text,text,text,integer,integer,integer,integer,integer,
  boolean,text,text,integer,text,bigint,integer,bigint
) from public, anon, authenticated;

grant execute on function public.begin_embedding_index_version(
  text,text,text,text,integer,text,text,text,text,text
) to service_role;
grant execute on function public.validate_embedding_index_version(
  text,text,text,integer,text,text,text
) to service_role;
grant execute on function public.discard_embedding_index_version(
  text,text,text,text,text,text
) to service_role;
grant execute on function public.recover_embedding_index_versions()
  to service_role;
grant execute on function public.verify_embedding_index_contract()
  to service_role;
grant execute on function public.publish_repository_snapshot(
  text,text,text,text,text,text,integer,integer,integer,integer,integer,
  boolean,text,text,integer,text,bigint,integer,bigint
) to service_role;

-- The worker contract version is the minimum migration that established the
-- contract, not the newest schema migration. Refresh the validator because this
-- migration replaces the worker's publication entry point with the
-- embedding-version-aware overload.
create or replace function public.validate_indexing_worker_contract()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  required_contract_migration constant text :=
    '20260802000000_add_worker_functional_readiness.sql';
  contract record;
  function_oid oid;
  actual_names text[];
  actual_result text;
  failures text[] := array[]::text[];
  required_relation text;
begin
  for contract in select * from (values
    ('claim_next_indexing_job', 'text,integer',
      array['input_worker_id','input_lease_ms'], 'SETOF indexing_jobs'),
    ('recover_stale_indexing_jobs',
      'timestamp with time zone,integer,timestamp with time zone',
      array['input_stale_before','input_retry_delay_ms','input_expired_before'],
      'SETOF indexing_jobs'),
    ('heartbeat_indexing_job', 'text,text,text,integer',
      array['input_job_id','input_worker_id','input_claim_token','input_lease_ms'],
      'boolean'),
    ('mark_indexing_job_running', 'text,text,text,text',
      array['input_job_id','input_worker_id','input_claim_token','input_stage'],
      'SETOF indexing_jobs'),
    ('complete_indexing_job', 'text,text,text',
      array['input_job_id','input_worker_id','input_claim_token'],
      'SETOF indexing_jobs'),
    ('fail_indexing_job', 'text,text,text,text,text,boolean',
      array['input_job_id','input_worker_id','input_claim_token',
        'input_failure_code','input_failure_message','input_failure_retryable'],
      'SETOF indexing_jobs'),
    ('fail_indexing_job', 'text,text,text,text,text,boolean,jsonb',
      array['input_job_id','input_worker_id','input_claim_token',
        'input_failure_code','input_failure_message','input_failure_retryable',
        'input_failure_details'],
      'SETOF indexing_jobs'),
    ('begin_repository_snapshot', 'text,text,text,text,text,text',
      array['input_repository_id','input_revision','input_branch','input_job_id',
        'input_worker_id','input_claim_token'],
      'TABLE(already_published boolean, chunk_count integer, file_count integer, symbol_count integer, graph_node_count integer, graph_edge_count integer, summary_available boolean)'),
    ('stage_repository_artifacts',
      'text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,bigint',
      array['input_repository_id','input_repository_revision','input_job_id',
        'input_worker_id','input_claim_token','input_graph','input_summary',
        'input_file_snapshot','input_symbol_index','input_graph_source',
        'input_max_artifact_bytes'],
      'void'),
    ('publish_repository_snapshot',
      'text,text,text,text,text,text,integer,integer,integer,integer,integer,boolean,text,text,integer,text,bigint,integer,bigint',
      array['input_repository_id','input_revision','input_branch','input_job_id',
        'input_worker_id','input_claim_token','input_chunk_count','input_file_count',
        'input_symbol_count','input_graph_node_count','input_graph_edge_count',
        'input_summary_available','input_embedding_version','input_index_mode',
        'input_changed_file_count','input_owner_user_id',
        'input_repository_storage_bytes','input_max_indexed_repositories',
        'input_max_user_storage_bytes'],
      'void'),
    ('record_indexing_worker_state',
      'text,text,text,boolean,integer,text,text,text,text,boolean,boolean,boolean,boolean,boolean',
      array['input_worker_id','input_shutdown_state','input_loop_state',
        'input_functional_ready','input_consecutive_database_failures',
        'input_active_job_id','input_last_completed_job_id','input_last_error_code',
        'input_last_error_message','input_loop_observed','input_poll_succeeded',
        'input_claim_succeeded','input_recovery_succeeded',
        'input_lease_heartbeat_succeeded'],
      'void')
  ) as expected(name, identity_arguments, argument_names, result_type)
  loop
    select proc.oid,
      case when proc.proargmodes is null then proc.proargnames else array(
        select arguments.name
        from unnest(proc.proargnames, proc.proargmodes) as arguments(name, mode)
        where arguments.mode in ('i','b','v')
      ) end,
      pg_catalog.pg_get_function_result(proc.oid)
    into function_oid, actual_names, actual_result
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace namespace on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = contract.name
      and pg_catalog.oidvectortypes(proc.proargtypes) = contract.identity_arguments;

    if function_oid is null then
      failures := array_append(failures, contract.name || ':missing_or_wrong_signature');
    elsif actual_names is distinct from contract.argument_names then
      failures := array_append(failures, contract.name || ':wrong_argument_names');
    elsif actual_result <> contract.result_type then
      failures := array_append(failures, contract.name || ':wrong_return_shape');
    elsif not pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE') then
      failures := array_append(failures, contract.name || ':wrong_grants');
    end if;
    function_oid := null;
  end loop;

  foreach required_relation in array array[
    'public.repositories','public.indexing_jobs','public.indexing_workers',
    'public.repository_snapshots','public.repository_artifacts',
    'public.repository_chunks','public.repository_summaries',
    'public.repository_quota_usage',
    'public.indexing_jobs_queued_claim_idx','public.indexing_jobs_expired_lease_idx',
    'public.indexing_jobs_claim_token_uidx','public.indexing_workers_health_idx',
    'public.indexing_workers_functional_readiness_idx'
  ] loop
    if pg_catalog.to_regclass(required_relation) is null then
      failures := array_append(failures, required_relation || ':missing');
    end if;
  end loop;

  foreach required_relation in array array[
    'public.repositories','public.indexing_jobs','public.indexing_workers',
    'public.repository_snapshots','public.repository_artifacts',
    'public.repository_chunks','public.repository_summaries',
    'public.repository_quota_usage'
  ] loop
    if not pg_catalog.has_table_privilege(
      'service_role', required_relation, 'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege('anon', required_relation, 'SELECT')
      or pg_catalog.has_table_privilege('authenticated', required_relation, 'SELECT') then
      failures := array_append(failures, required_relation || ':wrong_grants');
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_trigger trigger
    where trigger.tgname = 'repositories_enforce_version_increment'
      and trigger.tgrelid = 'public.repositories'::regclass
      and not trigger.tgisinternal
  ) then
    failures := array_append(failures, 'repository_cas:missing_trigger');
  end if;

  if coalesce(array_length(failures, 1), 0) > 0 then
    raise exception 'indexing_worker_contract_invalid:%', array_to_string(failures, ',')
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'migration_version', required_contract_migration,
    'required_contract_migration', required_contract_migration,
    'contract_valid', true,
    'validated_operations', array[
      'claim','recovery','lease_heartbeat','lease_fencing','completion','failure',
      'revision_publication','artifact_publication','repository_cas','worker_state'
    ]
  );
end;
$$;

revoke all on function public.validate_indexing_worker_contract()
  from public, anon, authenticated;
grant execute on function public.validate_indexing_worker_contract()
  to service_role;
