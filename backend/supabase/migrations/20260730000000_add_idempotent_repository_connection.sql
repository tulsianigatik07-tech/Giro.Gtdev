create table if not exists public.repository_connection_idempotency (
  owner_user_id text not null,
  idempotency_key text not null,
  payload_hash text not null,
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  job_id text not null references public.indexing_jobs(job_id) on delete cascade,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (owner_user_id, idempotency_key),
  constraint repository_connection_idempotency_owner_non_empty check (btrim(owner_user_id) <> ''),
  constraint repository_connection_idempotency_key_non_empty check (
    length(idempotency_key) between 1 and 200
  ),
  constraint repository_connection_idempotency_hash_sha256 check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint repository_connection_idempotency_expiry check (expires_at > created_at),
  constraint repository_connection_idempotency_response_shape check (
    response ? 'repositoryId' and response ? 'jobId' and response ? 'status'
  )
);

create index if not exists repository_connection_idempotency_expiry_idx
  on public.repository_connection_idempotency(expires_at);
create index if not exists repository_connection_idempotency_repository_idx
  on public.repository_connection_idempotency(repository_id, created_at desc);

alter table public.repository_connection_idempotency enable row level security;
revoke all on table public.repository_connection_idempotency from public, anon, authenticated;
grant select, insert, update, delete on table public.repository_connection_idempotency to service_role;

create or replace function public.connect_repository_idempotently(
  input_idempotency_key text,
  input_payload_hash text,
  input_owner_user_id text,
  input_repository_owner text,
  input_repository_name text,
  input_repository_url text,
  input_branch text,
  input_request_id text,
  input_traceparent text,
  input_max_attempts integer,
  input_max_concurrent_per_user integer,
  input_retention_ms bigint,
  input_statement_timeout_ms integer
)
returns table(response jsonb, job jsonb, replayed boolean)
language plpgsql security invoker set search_path = public as $$
declare
  repository_key text := input_repository_owner || '/' || input_repository_name;
  idempotency_row public.repository_connection_idempotency%rowtype;
  repository_row public.repositories%rowtype;
  job_row public.indexing_jobs%rowtype;
  response_value jsonb;
begin
  if input_statement_timeout_ms < 500 or input_statement_timeout_ms > 120000 then
    raise check_violation using message = 'invalid_statement_timeout';
  end if;
  if input_retention_ms < 60000 or input_retention_ms > 2592000000 then
    raise check_violation using message = 'invalid_idempotency_retention';
  end if;
  perform set_config('statement_timeout', input_statement_timeout_ms::text || 'ms', true);
  perform set_config('lock_timeout', input_statement_timeout_ms::text || 'ms', true);
  perform pg_advisory_xact_lock(hashtextextended(
    'repository-connection-idempotency:' || input_owner_user_id || ':' || input_idempotency_key,
    0
  ));

  delete from public.repository_connection_idempotency
    where owner_user_id = input_owner_user_id
      and idempotency_key = input_idempotency_key
      and expires_at <= now();
  select * into idempotency_row from public.repository_connection_idempotency
    where owner_user_id = input_owner_user_id and idempotency_key = input_idempotency_key
    for update;
  if found then
    if idempotency_row.payload_hash <> input_payload_hash then
      raise unique_violation using message = 'idempotency_conflict';
    end if;
    select * into job_row from public.indexing_jobs where job_id = idempotency_row.job_id;
    if not found then raise foreign_key_violation using message = 'idempotency_job_missing'; end if;
    return query select idempotency_row.response, to_jsonb(job_row), true;
    return;
  end if;

  select * into repository_row from public.repositories
    where repository_id = repository_key for update;
  if found then
    if repository_row.deletion_state <> 'active' then
      raise foreign_key_violation using message = 'repository_deleting_or_deleted';
    end if;
    if repository_row.owner_user_id is not null
       and repository_row.owner_user_id <> input_owner_user_id then
      raise insufficient_privilege using message = 'repository_owner_mismatch';
    end if;
    update public.repositories set owner_user_id = input_owner_user_id,
      status = 'indexing', updated_at = now()
      where repository_id = repository_key returning * into repository_row;
  else
    insert into public.repositories(
      repository_id, owner_user_id, repository_owner, repository_name,
      status, connected_at, updated_at
    ) values (
      repository_key, input_owner_user_id, input_repository_owner,
      input_repository_name, 'indexing', now(), now()
    ) returning * into repository_row;
  end if;

  select * into job_row from public.create_indexing_job(
    repository_key, input_owner_user_id, input_repository_owner,
    input_repository_name, input_repository_url, input_branch,
    input_max_attempts, input_request_id, input_traceparent,
    input_max_concurrent_per_user
  );
  if not found then raise check_violation using message = 'indexing_job_creation_failed'; end if;

  response_value := jsonb_build_object(
    'repositoryId', repository_key,
    'jobId', job_row.job_id,
    'status', 'queued'
  );
  insert into public.repository_connection_idempotency(
    owner_user_id, idempotency_key, payload_hash, repository_id,
    job_id, response, expires_at
  ) values (
    input_owner_user_id, input_idempotency_key, input_payload_hash,
    repository_key, job_row.job_id, response_value,
    now() + make_interval(secs => input_retention_ms::double precision / 1000.0)
  );
  return query select response_value, to_jsonb(job_row), false;
end; $$;

create or replace function public.cleanup_repository_connection_idempotency(
  input_statement_timeout_ms integer default 15000
)
returns bigint language plpgsql security invoker set search_path = public as $$
declare removed bigint;
begin
  perform set_config('statement_timeout', input_statement_timeout_ms::text || 'ms', true);
  with deleted as (
    delete from public.repository_connection_idempotency where expires_at <= now() returning 1
  ) select count(*) into removed from deleted;
  return removed;
end; $$;

create or replace function public.verify_repository_connection_idempotency(
  input_statement_timeout_ms integer default 15000
)
returns boolean language plpgsql security invoker set search_path = public as $$
begin
  perform set_config('statement_timeout', input_statement_timeout_ms::text || 'ms', true);
  return to_regclass('public.repository_connection_idempotency') is not null
    and to_regprocedure('public.connect_repository_idempotently(text,text,text,text,text,text,text,text,text,integer,integer,bigint,integer)') is not null
    and to_regprocedure('public.cleanup_repository_connection_idempotency(integer)') is not null;
end; $$;

revoke all on function public.connect_repository_idempotently(text,text,text,text,text,text,text,text,text,integer,integer,bigint,integer) from public, anon, authenticated;
revoke all on function public.cleanup_repository_connection_idempotency(integer) from public, anon, authenticated;
revoke all on function public.verify_repository_connection_idempotency(integer) from public, anon, authenticated;
grant execute on function public.connect_repository_idempotently(text,text,text,text,text,text,text,text,text,integer,integer,bigint,integer) to service_role;
grant execute on function public.cleanup_repository_connection_idempotency(integer) to service_role;
grant execute on function public.verify_repository_connection_idempotency(integer) to service_role;
