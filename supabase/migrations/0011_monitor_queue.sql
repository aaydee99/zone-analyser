-- Backup Console — monitoring at scale: one unit of work per check and account or zone, each with
-- its own schedule, result and table rows, so thousands of zones are checked a few at a time and
-- shown a page at a time (apply after 0010).
-- Rollback: supabase/rollbacks/0011_monitor_queue.down.sql
-- Only the service role reads these tables (RLS on, no policies), like the rest of the console.

-- What to check: one row per check and scope (a zone, an account, or '*' for the whole console).
-- The worker takes the rows that are due, a few per API token at a time, within each token's budget.
create table if not exists public.monitor_targets (
  check_id      text not null,
  scope_kind    text not null check (scope_kind in ('zone', 'account', 'global')),
  scope_id      text not null,
  account_id    text,
  account_name  text,
  zone_name     text,
  next_due_at   timestamptz not null default now(),
  -- Asked for by hand ("Run all checks", "Check now"): taken before scheduled work.
  priority      smallint not null default 0,
  lease_until   timestamptz,
  last_run_at   timestamptz,
  last_ok_at    timestamptz,
  last_error    text,
  fail_count    integer not null default 0,
  -- Cloudflare calls the last run took (how much of a token's budget the next one needs).
  cost          integer,
  primary key (check_id, scope_kind, scope_id)
);
create index if not exists monitor_targets_due_idx on public.monitor_targets (priority desc, next_due_at);
create index if not exists monitor_targets_zone_idx on public.monitor_targets (scope_id);

-- The newest result of each target: counts for the check's totals, and state for its next run.
create table if not exists public.monitor_results (
  check_id     text not null,
  scope_kind   text not null,
  scope_id     text not null,
  ran_at       timestamptz not null default now(),
  duration_ms  integer not null default 0,
  complete     boolean not null default true,
  problems     jsonb not null default '[]'::jsonb,
  counts       jsonb not null default '{}'::jsonb,
  state        jsonb,
  primary key (check_id, scope_kind, scope_id)
);

-- The table rows of each target's result, shown a page at a time with search.
create table if not exists public.monitor_rows (
  id          bigint generated always as identity primary key,
  check_id    text not null,
  section     text not null,
  scope_kind  text not null,
  scope_id    text not null,
  sort        double precision not null default 0,
  data        jsonb not null,
  search      text not null default ''
);
create index if not exists monitor_rows_page_idx on public.monitor_rows (check_id, section, sort, id);
create index if not exists monitor_rows_scope_idx on public.monitor_rows (check_id, scope_kind, scope_id);

-- Drift: each zone's accepted baseline and newest snapshot.
create table if not exists public.monitor_snapshots (
  zone_id      text not null,
  kind         text not null check (kind in ('baseline', 'latest')),
  data         jsonb not null,
  taken_at     timestamptz not null default now(),
  accepted_at  timestamptz,
  accepted_by  text,
  primary key (zone_id, kind)
);

-- Findings sorted by severity, and found by scope.
alter table public.monitor_findings add column if not exists severity_rank smallint generated always as (
  case severity when 'critical' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0 end) stored;
create index if not exists monitor_findings_rank_idx on public.monitor_findings (severity_rank desc, last_seen desc) where resolved_at is null;
create index if not exists monitor_findings_zone_idx on public.monitor_findings (check_id, zone_id) where resolved_at is null;
create index if not exists monitor_findings_account_idx on public.monitor_findings (check_id, account_id) where resolved_at is null;
create index if not exists monitor_findings_unsent_idx on public.monitor_findings (first_seen) where resolved_at is null and notified_at is null and dismissed_at is null;

-- Drift baselines taken before 0011 (one row with every zone) become one row per zone.
insert into public.monitor_snapshots (zone_id, kind, data, taken_at, accepted_at, accepted_by)
select z.key, 'baseline', z.value, coalesce((z.value->>'takenAt')::timestamptz, now()),
       (r.data->'acceptedAt'->z.key->>'at')::timestamptz, r.data->'acceptedAt'->z.key->>'by'
from public.monitor_reports r, jsonb_each(coalesce(r.data->'zones', '{}'::jsonb)) z
where r.check_id = 'drift:baseline'
on conflict (zone_id, kind) do nothing;
delete from public.monitor_reports where check_id in ('drift:baseline', 'drift:latest');

-- Each check's totals: its counts summed over every target, and how many targets were read.
create or replace function public.monitor_totals(p_check text)
returns table (key text, total double precision)
language sql stable set search_path = public as $$
  select e.key, sum((e.value)::text::double precision)
  from public.monitor_results r, jsonb_each(r.counts) e
  where r.check_id = p_check and jsonb_typeof(e.value) = 'number'
  group by e.key
$$;

-- Every check's coverage: targets, read without problems, failing, never read, due now.
create or replace function public.monitor_coverage()
returns table (check_id text, targets bigint, read_ok bigint, failing bigint, never bigint, due bigint, last_run timestamptz)
language sql stable set search_path = public as $$
  select t.check_id, count(*),
         count(*) filter (where t.last_ok_at is not null and t.last_error is null),
         count(*) filter (where t.last_error is not null),
         count(*) filter (where t.last_run_at is null),
         count(*) filter (where t.next_due_at <= now()),
         max(t.last_run_at)
  from public.monitor_targets t group by t.check_id
$$;

-- Open findings per check and severity (dismissed ones left out).
create or replace function public.monitor_open_counts()
returns table (check_id text, severity text, n bigint)
language sql stable set search_path = public as $$
  select f.check_id, f.severity, count(*) from public.monitor_findings f
  where f.resolved_at is null and f.dismissed_at is null group by f.check_id, f.severity
$$;

-- Accepts the newest drift snapshot of one zone (or of every zone) as its baseline, clears the
-- changes shown for it and closes its drift findings. Returns the zones accepted.
create or replace function public.monitor_accept_baseline(p_zone text, p_by text)
returns table (zone_id text, zone_name text)
language plpgsql set search_path = public as $$
declare
  ids text[];
begin
  select coalesce(array_agg(s.zone_id), '{}') into ids from public.monitor_snapshots s
  where s.kind = 'latest' and (p_zone is null or s.zone_id = p_zone);
  insert into public.monitor_snapshots (zone_id, kind, data, taken_at, accepted_at, accepted_by)
  select s.zone_id, 'baseline', s.data, s.taken_at, now(), p_by from public.monitor_snapshots s
  where s.kind = 'latest' and s.zone_id = any(ids)
  on conflict on constraint monitor_snapshots_pkey do update
    set data = excluded.data, taken_at = excluded.taken_at, accepted_at = excluded.accepted_at, accepted_by = excluded.accepted_by;
  delete from public.monitor_rows r where r.check_id = 'drift' and r.section = 'changes' and r.scope_id = any(ids);
  update public.monitor_rows r set data = r.data || jsonb_build_object('changes', 0, 'baseline', now(), 'acceptedBy', p_by, '_tone', 'ok')
  where r.check_id = 'drift' and r.section = 'zones' and r.scope_id = any(ids);
  update public.monitor_results r set counts = r.counts || '{"changes": 0, "changed": 0}'::jsonb
  where r.check_id = 'drift' and r.scope_kind = 'zone' and r.scope_id = any(ids);
  update public.monitor_findings f set resolved_at = now()
  where f.check_id = 'drift' and f.resolved_at is null and f.zone_id = any(ids);
  return query select s.zone_id, coalesce(s.data->>'zoneName', s.zone_id) from public.monitor_snapshots s
  where s.kind = 'baseline' and s.zone_id = any(ids);
end
$$;

alter table public.monitor_targets enable row level security;
alter table public.monitor_results enable row level security;
alter table public.monitor_rows enable row level security;
alter table public.monitor_snapshots enable row level security;
revoke all on public.monitor_targets, public.monitor_results, public.monitor_rows, public.monitor_snapshots from anon, authenticated;
revoke all on function public.monitor_totals(text), public.monitor_coverage(), public.monitor_open_counts(), public.monitor_accept_baseline(text, text) from public, anon, authenticated;
grant execute on function public.monitor_totals(text), public.monitor_coverage(), public.monitor_open_counts(), public.monitor_accept_baseline(text, text) to service_role;
