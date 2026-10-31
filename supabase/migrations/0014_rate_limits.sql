-- Backup Console — rate limits shared by every instance, and relayed calls that run only once
-- (apply after 0011, and after 0012/0013 when you have them).
-- Rollback: supabase/rollbacks/0014_rate_limits.down.sql
-- Only the service role reads these tables (RLS on, no policies), like the rest of the console.
-- Without this migration the console still works: each instance counts in its own memory, and the
-- worker remembers relayed calls in its own memory.

-- One counter per key (a SHA-256 of "user:<id>", "ip:<address>", "auth-fail:login:<email>" …: never
-- the address or email itself). A window starts at the first hit and lasts the window asked for.
create table if not exists public.rate_limits (
  key       text primary key,
  count     integer not null default 0,
  reset_at  timestamptz not null
);
create index if not exists rate_limits_reset_idx on public.rate_limits (reset_at);

-- Counts one hit, atomically (concurrent hits from any number of instances are all counted).
-- allowed: count <= p_limit; reset_ms: milliseconds until the window ends.
create or replace function public.rate_limit_hit(p_key text, p_window_ms integer, p_limit integer)
returns table (allowed boolean, count integer, reset_ms bigint)
language plpgsql set search_path = public as $$
#variable_conflict use_column
declare
  r public.rate_limits;
begin
  if p_key is null or length(p_key) > 200 or p_window_ms is null or p_window_ms < 1 or p_window_ms > 86400000 or p_limit is null then
    raise exception 'rate_limit_hit: invalid arguments';
  end if;
  insert into public.rate_limits as t (key, count, reset_at)
  values (p_key, 1, clock_timestamp() + make_interval(secs => p_window_ms / 1000.0))
  on conflict (key) do update set
    count    = case when t.reset_at <= clock_timestamp() then 1 else t.count + 1 end,
    reset_at = case when t.reset_at <= clock_timestamp() then excluded.reset_at else t.reset_at end
  returning t.* into r;
  -- Now and then, windows that ended a while ago are dropped.
  if random() < 0.01 then
    delete from public.rate_limits where reset_at < clock_timestamp() - interval '1 hour';
  end if;
  return query select r.count <= p_limit, r.count, greatest(0, (extract(epoch from (r.reset_at - clock_timestamp())) * 1000)::bigint);
end $$;

-- The current window of a key without counting a hit (no row when there is none).
create or replace function public.rate_limit_peek(p_key text)
returns table (count integer, reset_ms bigint)
language sql set search_path = public as $$
  select t.count, greatest(0, (extract(epoch from (t.reset_at - clock_timestamp())) * 1000)::bigint)
  from public.rate_limits t
  where t.key = p_key and t.reset_at > clock_timestamp()
$$;

-- Relayed calls the worker has run: a signed call is accepted once, even by another worker.
create table if not exists public.relay_calls_used (
  call_id     text primary key,
  expires_at  timestamptz not null
);
create index if not exists relay_calls_used_expires_idx on public.relay_calls_used (expires_at);

-- true the first time a call id is used, false every time after.
create or replace function public.relay_call_use(p_call text, p_expires_at timestamptz)
returns table (used boolean)
language plpgsql set search_path = public as $$
begin
  if p_call is null or length(p_call) > 100 then
    raise exception 'relay_call_use: invalid arguments';
  end if;
  -- Ids past their signature's expiry can never be accepted again anyway.
  if random() < 0.05 then
    delete from public.relay_calls_used where expires_at < clock_timestamp();
  end if;
  insert into public.relay_calls_used (call_id, expires_at) values (p_call, p_expires_at) on conflict (call_id) do nothing;
  return query select found;
end $$;

alter table public.rate_limits enable row level security;
alter table public.relay_calls_used enable row level security;
revoke all on public.rate_limits, public.relay_calls_used from anon, authenticated;
revoke all on function public.rate_limit_hit(text, integer, integer), public.rate_limit_peek(text), public.relay_call_use(text, timestamptz) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer), public.rate_limit_peek(text), public.relay_call_use(text, timestamptz) to service_role;
