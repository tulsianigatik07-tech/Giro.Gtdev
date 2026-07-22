create table if not exists public.repository_lifecycle_events (
  event_id text primary key,
  idempotency_key text not null,
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  owner_id text not null,
  repository_revision text,
  event_type text not null,
  event_payload jsonb not null,
  request_id text,
  trace_id text,
  created_at timestamptz not null,
  ordering_key bigint generated always as identity,
  retention_protected boolean not null default false,
  unique(repository_id, idempotency_key),
  constraint repository_lifecycle_owner_non_empty check (btrim(owner_id) <> ''),
  constraint repository_lifecycle_type_non_empty check (btrim(event_type) <> ''),
  constraint repository_lifecycle_payload_object check (jsonb_typeof(event_payload) = 'object')
);

create table if not exists public.repository_intelligence_history (
  intelligence_id text primary key,
  idempotency_key text not null,
  repository_id text not null references public.repositories(repository_id) on delete cascade,
  owner_id text not null,
  repository_revision text not null,
  intelligence_type text not null,
  normalized_payload jsonb not null,
  model_name text,
  provider_name text,
  generated_at timestamptz not null,
  ordering_key bigint generated always as identity,
  retention_protected boolean not null default false,
  unique(repository_id, intelligence_type, idempotency_key),
  constraint repository_intelligence_owner_non_empty check (btrim(owner_id) <> ''),
  constraint repository_intelligence_revision_non_empty check (btrim(repository_revision) <> ''),
  constraint repository_intelligence_type_non_empty check (btrim(intelligence_type) <> ''),
  constraint repository_intelligence_payload_present check (normalized_payload <> 'null'::jsonb)
);

create index if not exists repository_lifecycle_owner_pagination_idx
  on public.repository_lifecycle_events(repository_id, owner_id, ordering_key, event_id);
create index if not exists repository_lifecycle_revision_pagination_idx
  on public.repository_lifecycle_events(repository_id, owner_id, repository_revision, ordering_key, event_id);
create index if not exists repository_lifecycle_retention_idx
  on public.repository_lifecycle_events(repository_id, event_type, created_at, ordering_key)
  where not retention_protected;
create index if not exists repository_intelligence_owner_pagination_idx
  on public.repository_intelligence_history(repository_id, owner_id, ordering_key, intelligence_id);
create index if not exists repository_intelligence_revision_pagination_idx
  on public.repository_intelligence_history(repository_id, owner_id, repository_revision, intelligence_type, ordering_key, intelligence_id);
create index if not exists repository_intelligence_retention_idx
  on public.repository_intelligence_history(repository_id, intelligence_type, generated_at, ordering_key)
  where not retention_protected;

alter table public.repository_lifecycle_events enable row level security;
alter table public.repository_intelligence_history enable row level security;
revoke all on table public.repository_lifecycle_events from public, anon, authenticated;
revoke all on table public.repository_intelligence_history from public, anon, authenticated;
grant select, insert, update, delete on table public.repository_lifecycle_events to service_role;
grant select, insert, update, delete on table public.repository_intelligence_history to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.insert_repository_lifecycle_event(
  input_event_id text, input_idempotency_key text, input_repository_id text,
  input_owner_id text, input_repository_revision text, input_event_type text,
  input_event_payload jsonb, input_request_id text, input_trace_id text,
  input_created_at timestamptz, input_retention_protected boolean,
  input_statement_timeout_ms integer default 15000
) returns setof public.repository_lifecycle_events
language plpgsql security invoker set search_path = public as $$
declare repository_row public.repositories%rowtype;
begin
  perform set_config('statement_timeout', input_statement_timeout_ms::text || 'ms', true);
  select * into repository_row from public.repositories where repository_id = input_repository_id;
  if not found then raise no_data_found using message = 'repository_not_found'; end if;
  if repository_row.owner_user_id is distinct from input_owner_id then
    raise insufficient_privilege using message = 'repository_not_owned';
  end if;
  insert into public.repository_lifecycle_events(
    event_id, idempotency_key, repository_id, owner_id, repository_revision,
    event_type, event_payload, request_id, trace_id, created_at, retention_protected
  ) values (
    input_event_id, input_idempotency_key, input_repository_id, input_owner_id,
    input_repository_revision, input_event_type, input_event_payload,
    input_request_id, input_trace_id, input_created_at, input_retention_protected
  ) on conflict (repository_id, idempotency_key) do nothing;
  return query select * from public.repository_lifecycle_events events
    where events.repository_id = input_repository_id
      and events.owner_id = input_owner_id
      and events.idempotency_key = input_idempotency_key;
end; $$;

create or replace function public.insert_repository_intelligence_history(
  input_intelligence_id text, input_idempotency_key text, input_repository_id text,
  input_owner_id text, input_repository_revision text, input_intelligence_type text,
  input_normalized_payload jsonb, input_model_name text, input_provider_name text,
  input_generated_at timestamptz, input_retention_protected boolean,
  input_statement_timeout_ms integer default 15000
) returns setof public.repository_intelligence_history
language plpgsql security invoker set search_path = public as $$
declare repository_row public.repositories%rowtype;
begin
  perform set_config('statement_timeout', input_statement_timeout_ms::text || 'ms', true);
  select * into repository_row from public.repositories where repository_id = input_repository_id;
  if not found then raise no_data_found using message = 'repository_not_found'; end if;
  if repository_row.owner_user_id is distinct from input_owner_id then
    raise insufficient_privilege using message = 'repository_not_owned';
  end if;
  if input_repository_revision is distinct from repository_row.current_revision
    and input_repository_revision is distinct from repository_row.publishing_revision then
    raise check_violation using message = 'repository_revision_not_publishable';
  end if;
  insert into public.repository_intelligence_history(
    intelligence_id, idempotency_key, repository_id, owner_id, repository_revision,
    intelligence_type, normalized_payload, model_name, provider_name,
    generated_at, retention_protected
  ) values (
    input_intelligence_id, input_idempotency_key, input_repository_id, input_owner_id,
    input_repository_revision, input_intelligence_type, input_normalized_payload,
    input_model_name, input_provider_name, input_generated_at, input_retention_protected
  ) on conflict (repository_id, intelligence_type, idempotency_key) do nothing;
  return query select * from public.repository_intelligence_history history
    where history.repository_id = input_repository_id
      and history.owner_id = input_owner_id
      and history.intelligence_type = input_intelligence_type
      and history.idempotency_key = input_idempotency_key;
end; $$;

create or replace function public.list_repository_lifecycle_events(
  input_repository_id text, input_owner_id text, input_repository_revision text,
  input_event_type text, input_cursor_ordering_key bigint, input_cursor_record_id text,
  input_page_size integer, input_statement_timeout_ms integer default 15000
) returns setof public.repository_lifecycle_events
language plpgsql security invoker set search_path = public as $$
begin
  if input_page_size not between 1 and 1001 then raise check_violation using message = 'invalid_history_page_size'; end if;
  perform set_config('statement_timeout', input_statement_timeout_ms::text || 'ms', true);
  return query select * from public.repository_lifecycle_events events
  where events.repository_id = input_repository_id and events.owner_id = input_owner_id
    and (input_repository_revision is null or events.repository_revision = input_repository_revision)
    and (input_event_type is null or events.event_type = input_event_type)
    and (input_cursor_ordering_key is null or events.ordering_key > input_cursor_ordering_key
      or (events.ordering_key = input_cursor_ordering_key and events.event_id > input_cursor_record_id))
  order by events.ordering_key, events.event_id limit input_page_size;
end; $$;

create or replace function public.list_repository_intelligence_history(
  input_repository_id text, input_owner_id text, input_repository_revision text,
  input_intelligence_type text, input_cursor_ordering_key bigint, input_cursor_record_id text,
  input_page_size integer, input_statement_timeout_ms integer default 15000
) returns setof public.repository_intelligence_history
language plpgsql security invoker set search_path = public as $$
begin
  if input_page_size not between 1 and 1001 then raise check_violation using message = 'invalid_history_page_size'; end if;
  perform set_config('statement_timeout', input_statement_timeout_ms::text || 'ms', true);
  return query select * from public.repository_intelligence_history history
  where history.repository_id = input_repository_id and history.owner_id = input_owner_id
    and (input_repository_revision is null or history.repository_revision = input_repository_revision)
    and (input_intelligence_type is null or history.intelligence_type = input_intelligence_type)
    and (input_cursor_ordering_key is null or history.ordering_key > input_cursor_ordering_key
      or (history.ordering_key = input_cursor_ordering_key and history.intelligence_id > input_cursor_record_id))
  order by history.ordering_key, history.intelligence_id limit input_page_size;
end; $$;

create or replace function public.cleanup_repository_history(
  input_max_records_per_type integer, input_max_age_ms bigint,
  input_statement_timeout_ms integer default 15000
) returns bigint language plpgsql security invoker set search_path = public as $$
declare removed bigint := 0; step_removed bigint;
begin
  if input_max_records_per_type not between 1 and 10000
    or input_max_age_ms not between 86400000 and 31536000000 then
    raise check_violation using message = 'invalid_repository_history_retention';
  end if;
  perform set_config('statement_timeout', input_statement_timeout_ms::text || 'ms', true);
  perform pg_advisory_xact_lock(hashtextextended('repository_history_retention', 0));
  delete from public.repository_lifecycle_events events using public.repositories repositories
    where events.repository_id = repositories.repository_id
      and repositories.deletion_state = 'active' and not events.retention_protected
      and events.created_at < now() - make_interval(secs => input_max_age_ms::double precision / 1000.0);
  get diagnostics removed = row_count;
  delete from public.repository_intelligence_history history using public.repositories repositories
    where history.repository_id = repositories.repository_id
      and repositories.deletion_state = 'active' and not history.retention_protected
      and history.generated_at < now() - make_interval(secs => input_max_age_ms::double precision / 1000.0);
  get diagnostics step_removed = row_count; removed := removed + step_removed;
  with ranked as (
    select events.event_id, row_number() over (partition by events.repository_id, events.event_type order by events.ordering_key desc, events.event_id desc) rank
    from public.repository_lifecycle_events events join public.repositories repositories
      on repositories.repository_id = events.repository_id
    where not events.retention_protected and repositories.deletion_state = 'active'
  ) delete from public.repository_lifecycle_events events using ranked
    where events.event_id = ranked.event_id and ranked.rank > input_max_records_per_type;
  get diagnostics step_removed = row_count; removed := removed + step_removed;
  with ranked as (
    select history.intelligence_id, row_number() over (partition by history.repository_id, history.intelligence_type order by history.ordering_key desc, history.intelligence_id desc) rank
    from public.repository_intelligence_history history join public.repositories repositories
      on repositories.repository_id = history.repository_id
    where not history.retention_protected and repositories.deletion_state = 'active'
  ) delete from public.repository_intelligence_history history using ranked
    where history.intelligence_id = ranked.intelligence_id and ranked.rank > input_max_records_per_type;
  get diagnostics step_removed = row_count; removed := removed + step_removed;
  return removed;
end; $$;

create or replace function public.verify_repository_history_contract(
  input_statement_timeout_ms integer default 15000
) returns boolean language plpgsql security invoker set search_path = public as $$
begin
  perform set_config('statement_timeout', input_statement_timeout_ms::text || 'ms', true);
  return to_regclass('public.repository_lifecycle_events') is not null
    and to_regclass('public.repository_intelligence_history') is not null
    and to_regclass('public.repository_lifecycle_owner_pagination_idx') is not null
    and to_regclass('public.repository_intelligence_revision_pagination_idx') is not null
    and to_regprocedure('public.insert_repository_lifecycle_event(text,text,text,text,text,text,jsonb,text,text,timestamptz,boolean,integer)') is not null
    and to_regprocedure('public.insert_repository_intelligence_history(text,text,text,text,text,text,jsonb,text,text,timestamptz,boolean,integer)') is not null
    and to_regprocedure('public.list_repository_lifecycle_events(text,text,text,text,bigint,text,integer,integer)') is not null
    and to_regprocedure('public.list_repository_intelligence_history(text,text,text,text,bigint,text,integer,integer)') is not null
    and to_regprocedure('public.cleanup_repository_history(integer,bigint,integer)') is not null
    and (select relrowsecurity from pg_class where oid = 'public.repository_lifecycle_events'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.repository_intelligence_history'::regclass)
    and not has_table_privilege('anon', 'public.repository_lifecycle_events', 'select')
    and not has_table_privilege('authenticated', 'public.repository_intelligence_history', 'select')
    and has_function_privilege('service_role', 'public.list_repository_lifecycle_events(text,text,text,text,bigint,text,integer,integer)', 'execute')
    and not has_function_privilege('anon', 'public.list_repository_intelligence_history(text,text,text,text,bigint,text,integer,integer)', 'execute');
end; $$;

revoke all on function public.insert_repository_lifecycle_event(text,text,text,text,text,text,jsonb,text,text,timestamptz,boolean,integer) from public, anon, authenticated;
revoke all on function public.insert_repository_intelligence_history(text,text,text,text,text,text,jsonb,text,text,timestamptz,boolean,integer) from public, anon, authenticated;
revoke all on function public.list_repository_lifecycle_events(text,text,text,text,bigint,text,integer,integer) from public, anon, authenticated;
revoke all on function public.list_repository_intelligence_history(text,text,text,text,bigint,text,integer,integer) from public, anon, authenticated;
revoke all on function public.cleanup_repository_history(integer,bigint,integer) from public, anon, authenticated;
revoke all on function public.verify_repository_history_contract(integer) from public, anon, authenticated;
grant execute on function public.insert_repository_lifecycle_event(text,text,text,text,text,text,jsonb,text,text,timestamptz,boolean,integer) to service_role;
grant execute on function public.insert_repository_intelligence_history(text,text,text,text,text,text,jsonb,text,text,timestamptz,boolean,integer) to service_role;
grant execute on function public.list_repository_lifecycle_events(text,text,text,text,bigint,text,integer,integer) to service_role;
grant execute on function public.list_repository_intelligence_history(text,text,text,text,bigint,text,integer,integer) to service_role;
grant execute on function public.cleanup_repository_history(integer,bigint,integer) to service_role;
grant execute on function public.verify_repository_history_contract(integer) to service_role;
