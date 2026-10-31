-- Backup Console — zone health: one 0–100 score per zone from what monitoring stored (open findings
-- by severity and check, units that fail or were never read, the nearest certificate expiry, drift),
-- kept in a table that triggers bring up to date whenever a zone's monitoring unit finishes or one of
-- its findings is dismissed or resolved — so the Health page reads one indexed table. Also indexes
-- for the DNS hygiene and IP & ASN list pages (apply after 0011).
-- Rollback: supabase/rollbacks/0018_zone_health.down.sql
-- Only the service role reads these tables (RLS on, no policies), like the rest of the console.

create table if not exists public.zone_health (
  zone_id        text primary key,
  zone_name      text not null default '',
  account_id     text,
  account_name   text,
  score          smallint not null check (score between 0 and 100),
  open_findings  integer not null default 0,
  -- The worst open finding's severity rank (4 critical … 0 info), -1 without findings.
  worst_rank     smallint not null default -1,
  -- What took points off, and why: shown as the score's explanation.
  breakdown      jsonb not null default '{}'::jsonb,
  computed_at    timestamptz not null default now()
);
create index if not exists zone_health_score_idx on public.zone_health (score, zone_name);
create index if not exists zone_health_account_idx on public.zone_health (account_id, score);
create index if not exists zone_health_findings_idx on public.zone_health (open_findings desc, score);
create index if not exists zone_health_name_idx on public.zone_health (lower(zone_name) text_pattern_ops);

-- Open findings of a zone, whatever the check (the score reads them per zone).
create index if not exists monitor_findings_open_zone_idx on public.monitor_findings (zone_id) where resolved_at is null;
-- The lists page and the DNS hygiene zones (onboarding) filter stored rows by account and status.
create index if not exists monitor_rows_account_idx on public.monitor_rows (check_id, section, (data->>'accountId')) where check_id in ('lists', 'dns', 'loadbalancing');
create index if not exists monitor_rows_status_idx on public.monitor_rows (check_id, section, (data->>'status')) where check_id = 'dns';

-- Recomputes the score of the given zones (removes the ones monitoring no longer has).
-- Points off, at most 100 in all:
--   findings: 25 per critical, 10 per high, 4 per medium, 1 per low, times the check's weight
--             (drift 0 and certificates 0.5: they count below instead), at most 50 per check;
--   coverage: 3 per unit whose last read failed (at most 15), 1 per unit never read (at most 10);
--   certificates: 30 when one expired, 15 within 7 days, 5 within 30;
--   drift: 1 per change since the baseline, at most 10.
create or replace function public.zone_health_compute(p_zones text[])
returns integer
language plpgsql set search_path = public as $$
declare
  v_count integer;
begin
  if p_zones is null or cardinality(p_zones) = 0 then return 0; end if;
  with z as (select distinct unnest(p_zones) as zone_id),
  t as (
    select tg.scope_id as zone_id, max(tg.zone_name) as zone_name, max(tg.account_id) as account_id, max(tg.account_name) as account_name,
           count(*) as units, count(*) filter (where tg.last_error is not null) as failing, count(*) filter (where tg.last_run_at is null) as never
    from public.monitor_targets tg join z on z.zone_id = tg.scope_id
    where tg.scope_kind = 'zone' group by tg.scope_id
  ),
  f as (
    select fi.zone_id, fi.check_id, fi.severity, count(*) as n, max(fi.severity_rank) as rank
    from public.monitor_findings fi join z on z.zone_id = fi.zone_id
    where fi.resolved_at is null and fi.dismissed_at is null group by fi.zone_id, fi.check_id, fi.severity
  ),
  fc as (
    select f.zone_id, f.check_id,
           least(50, sum(f.n * (case f.severity when 'critical' then 25 when 'high' then 10 when 'medium' then 4 when 'low' then 1 else 0 end)
                 * (case f.check_id when 'drift' then 0 when 'certificates' then 0.5 else 1 end))) as penalty
    from f group by f.zone_id, f.check_id
  ),
  fz as (
    select f.zone_id, sum(f.n) as total, max(f.rank) as worst,
           jsonb_object_agg(f.severity, f.n) as by_sev
    from (select zone_id, severity, sum(n) as n, max(rank) as rank from f group by zone_id, severity) f group by f.zone_id
  ),
  fp as (select zone_id, sum(penalty) as penalty, jsonb_object_agg(check_id, round(penalty::numeric, 1)) filter (where penalty > 0) as by_check from fc group by zone_id),
  c as (
    select r.scope_id as zone_id, min((r.data->>'days')::integer) as min_days
    from public.monitor_rows r join z on z.zone_id = r.scope_id
    where r.check_id = 'certificates' and r.scope_kind = 'zone' and r.section = 'certificates' and (r.data->>'days') ~ '^-?[0-9]{1,6}$'
    group by r.scope_id
  ),
  d as (
    select r.scope_id as zone_id, coalesce((r.counts->>'changes')::numeric, 0) as changes
    from public.monitor_results r join z on z.zone_id = r.scope_id
    where r.check_id = 'drift' and r.scope_kind = 'zone' and jsonb_typeof(r.counts->'changes') = 'number'
  ),
  s as (
    select t.*, coalesce(fz.total, 0) as findings, coalesce(fz.worst, -1) as worst, coalesce(fz.by_sev, '{}'::jsonb) as by_sev,
           coalesce(fp.penalty, 0) as p_findings, coalesce(fp.by_check, '{}'::jsonb) as by_check,
           least(15, t.failing * 3) + least(10, t.never) as p_coverage,
           c.min_days, case when c.min_days is null then 0 when c.min_days < 0 then 30 when c.min_days <= 7 then 15 when c.min_days <= 30 then 5 else 0 end as p_cert,
           coalesce(d.changes, 0) as changes, least(10, coalesce(d.changes, 0)) as p_drift
    from t left join fz on fz.zone_id = t.zone_id left join fp on fp.zone_id = t.zone_id left join c on c.zone_id = t.zone_id left join d on d.zone_id = t.zone_id
  )
  insert into public.zone_health (zone_id, zone_name, account_id, account_name, score, open_findings, worst_rank, breakdown, computed_at)
  select s.zone_id, coalesce(s.zone_name, ''), s.account_id, s.account_name,
         greatest(0, 100 - round(least(100, s.p_findings + s.p_coverage + s.p_cert + s.p_drift)))::smallint,
         s.findings, s.worst,
         jsonb_build_object(
           'findings', jsonb_build_object('penalty', round(s.p_findings::numeric, 1), 'bySeverity', s.by_sev, 'byCheck', s.by_check),
           'coverage', jsonb_build_object('penalty', s.p_coverage, 'units', s.units, 'failing', s.failing, 'never', s.never),
           'certificates', jsonb_build_object('penalty', s.p_cert, 'minDays', s.min_days),
           'drift', jsonb_build_object('penalty', s.p_drift, 'changes', s.changes)),
         now()
  from s
  on conflict (zone_id) do update set zone_name = excluded.zone_name, account_id = excluded.account_id, account_name = excluded.account_name,
    score = excluded.score, open_findings = excluded.open_findings, worst_rank = excluded.worst_rank, breakdown = excluded.breakdown, computed_at = excluded.computed_at;
  get diagnostics v_count = row_count;
  -- Zones monitoring no longer has (no unit left).
  delete from public.zone_health h where h.zone_id = any(p_zones)
    and not exists (select 1 from public.monitor_targets tg where tg.scope_kind = 'zone' and tg.scope_id = h.zone_id);
  return v_count;
end
$$;

-- Triggers: a score is never what breaks a monitoring write, so a failure is only a warning
-- (the score is brought up to date on the zone's next run, or with zone_health_compute by hand).
create or replace function public.zone_health_on_targets()
returns trigger
language plpgsql set search_path = public as $$
declare
  ids text[];
begin
  if tg_op = 'UPDATE' then
    -- Only a finished run (not a lease being taken or renewed).
    select array_agg(distinct n.scope_id) into ids from new_rows n join old_rows o
      on o.check_id = n.check_id and o.scope_kind = n.scope_kind and o.scope_id = n.scope_id
      where n.scope_kind = 'zone' and (n.last_run_at is distinct from o.last_run_at or n.last_error is distinct from o.last_error);
  elsif tg_op = 'INSERT' then
    select array_agg(distinct n.scope_id) into ids from new_rows n where n.scope_kind = 'zone';
  else
    select array_agg(distinct o.scope_id) into ids from old_rows o where o.scope_kind = 'zone';
  end if;
  if ids is not null then
    begin
      perform public.zone_health_compute(ids);
    exception when others then
      raise warning 'zone_health: %', sqlerrm;
    end;
  end if;
  return null;
end
$$;

create or replace function public.zone_health_on_findings()
returns trigger
language plpgsql set search_path = public as $$
declare
  ids text[];
begin
  if tg_op = 'UPDATE' then
    -- Dismissed, brought back, resolved or reopened, or a new severity (not just seen again).
    select array_agg(distinct n.zone_id) into ids from new_rows n join old_rows o on o.id = n.id
      where n.zone_id is not null and (n.resolved_at is distinct from o.resolved_at or n.dismissed_at is distinct from o.dismissed_at or n.severity is distinct from o.severity);
  else
    select array_agg(distinct n.zone_id) into ids from new_rows n where n.zone_id is not null;
  end if;
  if ids is not null then
    begin
      perform public.zone_health_compute(ids);
    exception when others then
      raise warning 'zone_health: %', sqlerrm;
    end;
  end if;
  return null;
end
$$;

drop trigger if exists zone_health_targets_upd on public.monitor_targets;
drop trigger if exists zone_health_targets_ins on public.monitor_targets;
drop trigger if exists zone_health_targets_del on public.monitor_targets;
drop trigger if exists zone_health_findings_upd on public.monitor_findings;
drop trigger if exists zone_health_findings_ins on public.monitor_findings;
create trigger zone_health_targets_upd after update on public.monitor_targets referencing old table as old_rows new table as new_rows for each statement execute function public.zone_health_on_targets();
create trigger zone_health_targets_ins after insert on public.monitor_targets referencing new table as new_rows for each statement execute function public.zone_health_on_targets();
create trigger zone_health_targets_del after delete on public.monitor_targets referencing old table as old_rows for each statement execute function public.zone_health_on_targets();
create trigger zone_health_findings_upd after update on public.monitor_findings referencing old table as old_rows new table as new_rows for each statement execute function public.zone_health_on_findings();
create trigger zone_health_findings_ins after insert on public.monitor_findings referencing new table as new_rows for each statement execute function public.zone_health_on_findings();

-- One page of scores. p_zones: only these zones (a tag filter), null for all; p_q: the start of the
-- zone's name (LIKE wildcards already removed by the console), or its exact ID.
-- p_sort: 'score' (worst first, the default), 'best', 'name' or 'findings'.
create or replace function public.zone_health_page(p_account text, p_zones text[], p_q text, p_sort text, p_offset integer, p_limit integer)
returns table (zone_id text, zone_name text, account_id text, account_name text, score smallint, open_findings integer, worst_rank smallint, breakdown jsonb, computed_at timestamptz, total bigint)
language sql stable set search_path = public as $$
  select h.zone_id, h.zone_name, h.account_id, h.account_name, h.score, h.open_findings, h.worst_rank, h.breakdown, h.computed_at, count(*) over ()
  from public.zone_health h
  where (p_account is null or h.account_id = p_account)
    and (p_zones is null or h.zone_id = any(p_zones))
    and (coalesce(p_q, '') = '' or lower(h.zone_name) like lower(p_q) || '%' or h.zone_id = p_q)
  order by
    case when p_sort = 'name' then lower(h.zone_name) end asc,
    case when p_sort = 'best' then h.score end desc,
    case when p_sort = 'findings' then h.open_findings end desc,
    h.score asc, h.worst_rank desc, h.open_findings desc, h.zone_name asc
  offset greatest(0, coalesce(p_offset, 0)) limit least(200, greatest(1, coalesce(p_limit, 50)))
$$;

-- The estate at a glance (or one account's): zones scored, the average, and how many in each band.
create or replace function public.zone_health_summary(p_account text, p_zones text[])
returns table (zones bigint, average numeric, poor bigint, fair bigint, good bigint, computed_at timestamptz)
language sql stable set search_path = public as $$
  select count(*), round(avg(h.score), 1), count(*) filter (where h.score < 50), count(*) filter (where h.score >= 50 and h.score < 80),
         count(*) filter (where h.score >= 80), max(h.computed_at)
  from public.zone_health h
  where (p_account is null or h.account_id = p_account) and (p_zones is null or h.zone_id = any(p_zones))
$$;

-- Accounts with scored zones (the page's account filter), with their zone count and average.
create or replace function public.zone_health_accounts()
returns table (account_id text, account_name text, zones bigint, average numeric)
language sql stable set search_path = public as $$
  select h.account_id, max(h.account_name), count(*), round(avg(h.score), 1)
  from public.zone_health h where h.account_id is not null group by h.account_id order by max(h.account_name) limit 1000
$$;

-- Scores for what monitoring already stored.
select public.zone_health_compute(coalesce((select array_agg(distinct scope_id) from public.monitor_targets where scope_kind = 'zone'), '{}'));

alter table public.zone_health enable row level security;
revoke all on public.zone_health from anon, authenticated;
revoke all on function public.zone_health_compute(text[]), public.zone_health_on_targets(), public.zone_health_on_findings(),
  public.zone_health_page(text, text[], text, text, integer, integer), public.zone_health_summary(text, text[]), public.zone_health_accounts() from public, anon, authenticated;
grant execute on function public.zone_health_compute(text[]), public.zone_health_page(text, text[], text, text, integer, integer), public.zone_health_summary(text, text[]), public.zone_health_accounts() to service_role;
