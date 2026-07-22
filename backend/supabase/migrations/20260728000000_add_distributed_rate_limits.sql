create table if not exists public.rate_limit_buckets (
  bucket_key text primary key,
  request_count bigint not null,
  window_ms integer not null,
  reset_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint rate_limit_buckets_key_valid check (bucket_key ~ '^[0-9a-f]{64}$'),
  constraint rate_limit_buckets_count_valid check (request_count >= 1),
  constraint rate_limit_buckets_window_valid check (window_ms between 1000 and 3600000)
);

create index if not exists rate_limit_buckets_expiration_idx
  on public.rate_limit_buckets(reset_at, bucket_key);

alter table public.rate_limit_buckets enable row level security;
revoke all on table public.rate_limit_buckets from public, anon, authenticated;
grant all on table public.rate_limit_buckets to service_role;

create or replace function public.increment_rate_limit(
  input_bucket_key text,
  input_window_ms integer
)
returns table(request_count bigint, reset_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
  effective_now timestamptz := clock_timestamp();
begin
  if input_bucket_key is null or input_bucket_key !~ '^[0-9a-f]{64}$' then
    raise check_violation using message = 'rate-limit bucket key is invalid';
  end if;
  if input_window_ms < 1000 or input_window_ms > 3600000 then
    raise check_violation using message = 'rate-limit window is invalid';
  end if;

  return query
  insert into public.rate_limit_buckets as buckets(
    bucket_key, request_count, window_ms, reset_at, updated_at
  ) values (
    input_bucket_key, 1, input_window_ms,
    effective_now + make_interval(secs => input_window_ms::double precision / 1000.0),
    effective_now
  )
  on conflict (bucket_key) do update set
    request_count = case
      when buckets.reset_at <= effective_now or buckets.window_ms <> input_window_ms then 1
      else buckets.request_count + 1
    end,
    window_ms = input_window_ms,
    reset_at = case
      when buckets.reset_at <= effective_now or buckets.window_ms <> input_window_ms
        then effective_now + make_interval(secs => input_window_ms::double precision / 1000.0)
      else buckets.reset_at
    end,
    updated_at = effective_now
  returning buckets.request_count, buckets.reset_at;

  -- Bounded opportunistic collection keeps expired identities from accumulating
  -- without requiring pg_cron or a replica-local cleanup timer.
  delete from public.rate_limit_buckets expired
  where expired.bucket_key in (
    select candidates.bucket_key
    from public.rate_limit_buckets candidates
    where candidates.reset_at <= effective_now
      and candidates.bucket_key <> input_bucket_key
    order by candidates.reset_at, candidates.bucket_key
    limit 100
  );
end;
$$;

create or replace function public.verify_rate_limit_backend()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select to_regclass('public.rate_limit_buckets') is not null
    and to_regprocedure('public.increment_rate_limit(text,integer)') is not null;
$$;

revoke all on function public.increment_rate_limit(text,integer) from public, anon, authenticated;
revoke all on function public.verify_rate_limit_backend() from public, anon, authenticated;
grant execute on function public.increment_rate_limit(text,integer) to service_role;
grant execute on function public.verify_rate_limit_backend() to service_role;
