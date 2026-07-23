alter table public.indexing_workers
  add column if not exists loop_state text not null default 'starting',
  add column if not exists functional_ready boolean not null default false,
  add column if not exists consecutive_database_failures integer not null default 0,
  add column if not exists last_loop_at timestamptz,
  add column if not exists last_successful_poll_at timestamptz,
  add column if not exists last_successful_claim_at timestamptz,
  add column if not exists last_successful_recovery_at timestamptz,
  add column if not exists last_successful_lease_heartbeat_at timestamptz;

alter table public.indexing_workers
  drop constraint if exists indexing_workers_loop_state_valid,
  drop constraint if exists indexing_workers_database_failures_nonnegative,
  add constraint indexing_workers_loop_state_valid check (
    loop_state in ('starting','recovering','polling','idle','processing','stopping','stopped','failed')
  ),
  add constraint indexing_workers_database_failures_nonnegative check (
    consecutive_database_failures >= 0
  );

create index if not exists indexing_workers_functional_readiness_idx
  on public.indexing_workers (
    functional_ready, shutdown_state, last_loop_at desc, last_successful_poll_at desc
  );

drop function if exists public.record_indexing_worker_state(text,text,text,text,text,text,boolean);
create function public.record_indexing_worker_state(
  input_worker_id text,
  input_shutdown_state text,
  input_loop_state text,
  input_functional_ready boolean,
  input_consecutive_database_failures integer,
  input_active_job_id text,
  input_last_completed_job_id text,
  input_last_error_code text,
  input_last_error_message text,
  input_loop_observed boolean,
  input_poll_succeeded boolean,
  input_claim_succeeded boolean,
  input_recovery_succeeded boolean,
  input_lease_heartbeat_succeeded boolean
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.indexing_workers (
    worker_id, shutdown_state, loop_state, functional_ready,
    consecutive_database_failures, active_job_id, last_completed_job_id,
    last_error_code, last_error_message, last_loop_at,
    last_successful_poll_at, last_successful_claim_at,
    last_successful_recovery_at, last_successful_lease_heartbeat_at, stopped_at
  ) values (
    input_worker_id, input_shutdown_state, input_loop_state, input_functional_ready,
    input_consecutive_database_failures, input_active_job_id, input_last_completed_job_id,
    input_last_error_code, input_last_error_message,
    case when input_loop_observed then now() else null end,
    case when input_poll_succeeded then now() else null end,
    case when input_claim_succeeded then now() else null end,
    case when input_recovery_succeeded then now() else null end,
    case when input_lease_heartbeat_succeeded then now() else null end,
    case when input_shutdown_state = 'stopped' then now() else null end
  )
  on conflict (worker_id) do update set
    shutdown_state = excluded.shutdown_state,
    loop_state = excluded.loop_state,
    functional_ready = excluded.functional_ready,
    consecutive_database_failures = excluded.consecutive_database_failures,
    active_job_id = excluded.active_job_id,
    last_completed_job_id = coalesce(excluded.last_completed_job_id, indexing_workers.last_completed_job_id),
    last_error_code = excluded.last_error_code,
    last_error_message = excluded.last_error_message,
    last_loop_at = coalesce(excluded.last_loop_at, indexing_workers.last_loop_at),
    last_successful_poll_at = coalesce(excluded.last_successful_poll_at, indexing_workers.last_successful_poll_at),
    last_successful_claim_at = coalesce(excluded.last_successful_claim_at, indexing_workers.last_successful_claim_at),
    last_successful_recovery_at = coalesce(excluded.last_successful_recovery_at, indexing_workers.last_successful_recovery_at),
    last_successful_lease_heartbeat_at = coalesce(excluded.last_successful_lease_heartbeat_at, indexing_workers.last_successful_lease_heartbeat_at),
    heartbeat_at = now(),
    stopped_at = case when excluded.shutdown_state = 'stopped' then now() else null end,
    updated_at = now();
end;
$$;

revoke all on function public.record_indexing_worker_state(
  text,text,text,boolean,integer,text,text,text,text,boolean,boolean,boolean,boolean,boolean
) from public, anon, authenticated;
grant execute on function public.record_indexing_worker_state(
  text,text,text,boolean,integer,text,text,text,text,boolean,boolean,boolean,boolean,boolean
) to service_role;

create or replace function public.validate_indexing_worker_contract()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  expected_version constant text := '20260802000000_add_worker_functional_readiness.sql';
  contract record;
  function_oid oid;
  actual_names text[];
  actual_result text;
  failures text[] := array[]::text[];
  required_relation text;
begin
  for contract in select * from (values
    ('claim_next_indexing_job', 'text,integer', array['input_worker_id','input_lease_ms'], 'SETOF indexing_jobs'),
    ('recover_stale_indexing_jobs', 'timestamp with time zone,integer,timestamp with time zone', array['input_stale_before','input_retry_delay_ms','input_expired_before'], 'SETOF indexing_jobs'),
    ('heartbeat_indexing_job', 'text,text,text,integer', array['input_job_id','input_worker_id','input_claim_token','input_lease_ms'], 'boolean'),
    ('mark_indexing_job_running', 'text,text,text,text', array['input_job_id','input_worker_id','input_claim_token','input_stage'], 'SETOF indexing_jobs'),
    ('complete_indexing_job', 'text,text,text', array['input_job_id','input_worker_id','input_claim_token'], 'SETOF indexing_jobs'),
    ('fail_indexing_job', 'text,text,text,text,text,boolean', array['input_job_id','input_worker_id','input_claim_token','input_failure_code','input_failure_message','input_failure_retryable'], 'SETOF indexing_jobs'),
    ('fail_indexing_job', 'text,text,text,text,text,boolean,jsonb', array['input_job_id','input_worker_id','input_claim_token','input_failure_code','input_failure_message','input_failure_retryable','input_failure_details'], 'SETOF indexing_jobs'),
    ('begin_repository_snapshot', 'text,text,text,text,text,text', array['input_repository_id','input_revision','input_branch','input_job_id','input_worker_id','input_claim_token'], 'TABLE(already_published boolean, chunk_count integer, file_count integer, symbol_count integer, graph_node_count integer, graph_edge_count integer, summary_available boolean)'),
    ('stage_repository_artifacts', 'text,text,text,text,text,jsonb,jsonb,jsonb,jsonb,jsonb,bigint', array['input_repository_id','input_repository_revision','input_job_id','input_worker_id','input_claim_token','input_graph','input_summary','input_file_snapshot','input_symbol_index','input_graph_source','input_max_artifact_bytes'], 'void'),
    ('publish_repository_snapshot', 'text,text,text,text,text,text,integer,integer,integer,integer,integer,boolean,text,integer,text,bigint,integer,bigint', array['input_repository_id','input_revision','input_branch','input_job_id','input_worker_id','input_claim_token','input_chunk_count','input_file_count','input_symbol_count','input_graph_node_count','input_graph_edge_count','input_summary_available','input_index_mode','input_changed_file_count','input_owner_user_id','input_repository_storage_bytes','input_max_indexed_repositories','input_max_user_storage_bytes'], 'void'),
    ('record_indexing_worker_state', 'text,text,text,boolean,integer,text,text,text,text,boolean,boolean,boolean,boolean,boolean', array['input_worker_id','input_shutdown_state','input_loop_state','input_functional_ready','input_consecutive_database_failures','input_active_job_id','input_last_completed_job_id','input_last_error_code','input_last_error_message','input_loop_observed','input_poll_succeeded','input_claim_succeeded','input_recovery_succeeded','input_lease_heartbeat_succeeded'], 'void')
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
      and replace(
        pg_catalog.oidvectortypes(proc.proargtypes), ', ', ','
      ) = contract.identity_arguments;

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
    'public.repository_chunks','public.repository_summaries','public.repository_quota_usage',
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
    'public.repository_chunks','public.repository_summaries','public.repository_quota_usage'
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
    'migration_version', expected_version,
    'contract_valid', true,
    'validated_operations', array[
      'claim','recovery','lease_heartbeat','lease_fencing','completion','failure',
      'revision_publication','artifact_publication','repository_cas','worker_state'
    ]
  );
end;
$$;

revoke all on function public.validate_indexing_worker_contract() from public, anon, authenticated;
grant execute on function public.validate_indexing_worker_contract() to service_role;
