-- Backup Console — security audits of one zone (Security audit page): a fixed set of read-only
-- checks of the zone's configuration and of how its security rules acted on traffic, kept as a
-- report per run. Kept: the newest 20 audits per zone.
-- Rollback: supabase/rollbacks/0021_zone_audits.down.sql
-- Only the service role reads this table (RLS on, no policies), like the rest of the console.
-- Without this migration the console still works; the Security audit page and its API answer 503
-- naming this file.

create table if not exists public.zone_audits (
  id           uuid primary key default gen_random_uuid(),
  zone_id      text not null check (zone_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  zone_name    text not null default '' check (length(zone_name) <= 253),
  account_id   text,
  started_by   text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running', 'ready', 'failed')),
  -- The traffic window asked for (hours).
  hours        integer not null default 168 check (hours between 1 and 744),
  -- The worst severity found (critical 4 … info 0), null while running or when nothing was found.
  worst_rank   smallint check (worst_rank between 0 and 4),
  -- True on the newest audit of each zone (for the all-zones list).
  latest       boolean not null default true,
  summary      jsonb,
  report       jsonb,
  error        text
);
-- A zone's history, newest first; the running ones; the all-zones list (latest only) by worst, by date and by name.
create index if not exists zone_audits_zone_idx on public.zone_audits (zone_id, started_at desc);
create index if not exists zone_audits_running_idx on public.zone_audits (started_at) where status = 'running';
create index if not exists zone_audits_latest_worst_idx on public.zone_audits (worst_rank desc nulls last, started_at desc) where latest;
create index if not exists zone_audits_latest_started_idx on public.zone_audits (started_at desc) where latest;
create index if not exists zone_audits_latest_name_idx on public.zone_audits (lower(zone_name), zone_id) where latest;

-- Starts an audit of one zone: refused (nothing returned) while one of the same zone has been running
-- for less than 15 minutes. Running audits older than that are marked failed (their worker stopped).
-- The new audit becomes the zone's latest; audits past the newest 20 of the zone are deleted.
create or replace function public.zone_audit_start(p_zone text, p_zone_name text, p_account text, p_by text, p_hours integer)
returns table (id uuid, zone_id text, zone_name text, account_id text, started_by text, started_at timestamptz, finished_at timestamptz, status text, hours integer)
language plpgsql volatile set search_path = public as $$
declare
  r public.zone_audits;
begin
  perform pg_advisory_xact_lock(hashtext('zone_audit:' || p_zone));
  update public.zone_audits a set status = 'failed', finished_at = now(), error = 'The audit stopped before it finished (the worker restarted) — run it again'
  where a.zone_id = p_zone and a.status = 'running' and a.started_at <= now() - interval '15 minutes';
  if exists (select 1 from public.zone_audits a where a.zone_id = p_zone and a.status = 'running') then return; end if;
  update public.zone_audits a set latest = false where a.zone_id = p_zone and a.latest;
  insert into public.zone_audits (zone_id, zone_name, account_id, started_by, hours, latest)
  values (p_zone, coalesce(p_zone_name, ''), p_account, p_by, p_hours, true)
  returning * into r;
  delete from public.zone_audits x where x.zone_id = p_zone and x.id in (
    select y.id from public.zone_audits y where y.zone_id = p_zone order by y.started_at desc offset 20);
  return query select r.id, r.zone_id, r.zone_name, r.account_id, r.started_by, r.started_at, r.finished_at, r.status, r.hours;
end $$;

-- The newest audit of every zone, a page at a time: p_sort 'worst' (worst severity, then newest),
-- 'newest' or 'name'; p_q matches the zone name. Without the report; with the total.
create or replace function public.zone_audit_latest(p_q text, p_sort text, p_offset integer, p_limit integer)
returns table (id uuid, zone_id text, zone_name text, account_id text, started_by text, started_at timestamptz, finished_at timestamptz, status text, hours integer, summary jsonb, error text, total bigint)
language sql stable set search_path = public as $$
  select a.id, a.zone_id, a.zone_name, a.account_id, a.started_by, a.started_at, a.finished_at, a.status, a.hours, a.summary, a.error, count(*) over ()
  from public.zone_audits a
  where a.latest and (coalesce(p_q, '') = '' or lower(a.zone_name) like '%' || lower(replace(replace(replace(p_q, '\', '\\'), '%', '\%'), '_', '\_')) || '%' or a.zone_id = p_q)
  order by
    case when p_sort = 'worst' then a.worst_rank end desc nulls last,
    case when p_sort = 'name' then lower(a.zone_name) end asc,
    a.started_at desc, a.id
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

alter table public.zone_audits enable row level security;
revoke all on public.zone_audits from anon, authenticated;
revoke all on function public.zone_audit_start(text, text, text, text, integer), public.zone_audit_latest(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.zone_audit_start(text, text, text, text, integer), public.zone_audit_latest(text, text, integer, integer) to service_role;
