-- Backup Console — scheduled reports (daily or weekly summaries of Cloudflare changes, monitoring
-- findings, traffic, expiring certificates and coverage, sent to Slack or the webhook), and the
-- allow-list of Slack users who may use the read-only /castellan command (apply after 0011; the
-- report sections read the monitoring tables of 0010/0011 when you have them).
-- Rollback: supabase/rollbacks/0020_reports.down.sql
-- Only the service role reads these tables (RLS on, no policies), like the rest of the console.
-- Without this migration the console still works; the Reports page and the Slack command answer
-- 503 naming this file.

-- What a report covers, when it runs (UTC) and where it goes.
create table if not exists public.report_definitions (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(name) between 1 and 120),
  -- all: every zone; accounts: the zones of these accounts; tag: the zones with every one of these tags.
  scope_kind      text not null check (scope_kind in ('all', 'accounts', 'tag')),
  scope_accounts  text[] not null default '{}' check (cardinality(scope_accounts) <= 200),
  scope_tags      text[] not null default '{}' check (cardinality(scope_tags) <= 10),
  cadence         text not null check (cadence in ('daily', 'weekly')),
  -- 0 = Sunday … 6 = Saturday (weekly only).
  weekday         smallint check (weekday between 0 and 6),
  hour            smallint not null check (hour between 0 and 23),
  sections        text[] not null default '{}',
  -- 'slack' and/or 'webhook': the addresses set in Monitoring › Settings.
  channels        text[] not null default '{}',
  enabled         boolean not null default true,
  next_run_at     timestamptz,
  last_run_at     timestamptz,
  created_at      timestamptz not null default now(),
  created_by      text,
  updated_at      timestamptz not null default now(),
  updated_by      text
);
-- The reports due now (the worker looks every minute), and the list sorted by name.
create index if not exists report_definitions_due_idx on public.report_definitions (next_run_at) where enabled;
create index if not exists report_definitions_name_idx on public.report_definitions (lower(name), id);

-- Each report made: what it covered, what it found, and where it was sent. Kept: the newest 50 per report.
create table if not exists public.report_runs (
  id              uuid primary key default gen_random_uuid(),
  definition_id   uuid not null references public.report_definitions (id) on delete cascade,
  trigger         text not null check (trigger in ('schedule', 'manual')),
  requested_by    text,
  status          text not null check (status in ('running', 'ready', 'failed')),
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  -- New and resolved findings are counted from here (the end of the report before, or period_start).
  since           timestamptz not null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  -- The worker making it (a random id per worker process).
  owner           text,
  content         jsonb,
  error           text,
  -- { "<channel>": { "state": "sending" | "sent" | "failed", "at": …, "error": … } } — each channel once, never retried.
  deliveries      jsonb not null default '{}'::jsonb
);
create index if not exists report_runs_definition_idx on public.report_runs (definition_id, started_at desc);
create index if not exists report_runs_running_idx on public.report_runs (started_at) where status = 'running';

-- Slack users who may use the read-only command, each acting as one console user (with that user's role).
create table if not exists public.slack_users (
  slack_user_id  text primary key check (slack_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  -- The Slack workspace (T…); null: any workspace the signing secret belongs to.
  team_id        text check (team_id is null or team_id ~ '^[TE][A-Z0-9]{2,30}$'),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  note           text not null default '' check (length(note) <= 200),
  added_at       timestamptz not null default now(),
  added_by       text
);
create index if not exists slack_users_user_idx on public.slack_users (user_id);
create index if not exists slack_users_added_idx on public.slack_users (added_at desc);

-- Findings found or resolved in a period, and failed reads, without reading every row.
create index if not exists monitor_findings_first_seen_idx on public.monitor_findings (first_seen);
create index if not exists monitor_findings_resolved_at_idx on public.monitor_findings (resolved_at) where resolved_at is not null;
create index if not exists monitor_targets_failing_idx on public.monitor_targets (last_run_at desc) where last_error is not null;

-- A due report is taken by one worker only: its next run moves on (only if it is still p_due) and a
-- run is started in the same statement. Returns the run, or nothing when another worker took it.
-- Older runs past the newest 50 of the report are deleted.
create or replace function public.report_claim(p_id uuid, p_due timestamptz, p_next timestamptz, p_owner text, p_span interval)
returns setof public.report_runs
language plpgsql volatile set search_path = public as $$
declare
  prev timestamptz;
  r public.report_runs;
begin
  update public.report_definitions set next_run_at = p_next, last_run_at = now()
  where id = p_id and enabled and next_run_at = p_due;
  if not found then return; end if;
  select max(x.period_end) into prev from public.report_runs x where x.definition_id = p_id and x.status = 'ready';
  insert into public.report_runs (definition_id, trigger, status, period_start, period_end, since, owner)
  values (p_id, 'schedule', 'running', now() - p_span, now(), greatest(coalesce(prev, now() - p_span), now() - interval '31 days'), p_owner)
  returning * into r;
  delete from public.report_runs x where x.definition_id = p_id and x.id in (
    select y.id from public.report_runs y where y.definition_id = p_id order by y.started_at desc offset 50);
  return next r;
end $$;

-- A report made by hand (Generate now): refused (nothing returned) while one of the same report has
-- been running for less than 30 minutes.
create or replace function public.report_start(p_id uuid, p_by text, p_owner text, p_span interval)
returns setof public.report_runs
language plpgsql volatile set search_path = public as $$
declare
  prev timestamptz;
  r public.report_runs;
begin
  perform 1 from public.report_definitions d where d.id = p_id for update;
  if not found then return; end if;
  if exists (select 1 from public.report_runs x where x.definition_id = p_id and x.status = 'running' and x.started_at > now() - interval '30 minutes') then return; end if;
  select max(x.period_end) into prev from public.report_runs x where x.definition_id = p_id and x.status = 'ready';
  insert into public.report_runs (definition_id, trigger, requested_by, status, period_start, period_end, since, owner)
  values (p_id, 'manual', p_by, 'running', now() - p_span, now(), greatest(coalesce(prev, now() - p_span), now() - interval '31 days'), p_owner)
  returning * into r;
  delete from public.report_runs x where x.definition_id = p_id and x.id in (
    select y.id from public.report_runs y where y.definition_id = p_id order by y.started_at desc offset 50);
  return next r;
end $$;

-- Takes one channel of a run for sending: true only the first time (a run goes to a channel once).
create or replace function public.report_claim_delivery(p_run uuid, p_channel text)
returns table (claimed boolean)
language sql volatile set search_path = public as $$
  with u as (
    update public.report_runs set deliveries = deliveries || jsonb_build_object(p_channel, jsonb_build_object('state', 'sending', 'at', now()))
    where id = p_run and status = 'ready' and not (deliveries ? p_channel)
    returning 1)
  select exists (select 1 from u)
$$;

-- Records how sending to a channel went (after report_claim_delivery).
create or replace function public.report_delivered(p_run uuid, p_channel text, p_ok boolean, p_error text)
returns void
language sql volatile set search_path = public as $$
  update public.report_runs set deliveries = deliveries || jsonb_build_object(p_channel,
    jsonb_build_object('state', case when p_ok then 'sent' else 'failed' end, 'at', now(), 'error', left(p_error, 300)))
  where id = p_run
$$;

-- Findings per severity: open now (not dismissed), new in [p_since, p_until), resolved in it.
-- p_accounts / p_zones null: no filter. Only the checks in p_checks.
create or replace function public.report_finding_counts(p_checks text[], p_accounts text[], p_zones text[], p_since timestamptz, p_until timestamptz)
returns table (severity text, open bigint, fresh bigint, resolved bigint)
language sql stable set search_path = public as $$
  select f.severity,
         count(*) filter (where f.resolved_at is null and f.dismissed_at is null),
         count(*) filter (where f.first_seen >= p_since and f.first_seen < p_until and f.dismissed_at is null),
         count(*) filter (where f.resolved_at >= p_since and f.resolved_at < p_until)
  from public.monitor_findings f
  where f.check_id = any(p_checks)
    and (p_accounts is null or f.account_id = any(p_accounts))
    and (p_zones is null or f.zone_id = any(p_zones))
    and (f.resolved_at is null or f.resolved_at >= p_since)
  group by f.severity
$$;

-- The worst findings of one kind ('open', 'new' or 'resolved' in the period), up to p_limit.
create or replace function public.report_findings_list(p_checks text[], p_accounts text[], p_zones text[], p_since timestamptz, p_until timestamptz, p_kind text, p_limit integer)
returns table (id text, check_id text, severity text, title text, account_name text, zone_name text, first_seen timestamptz, resolved_at timestamptz)
language sql stable set search_path = public as $$
  select f.id, f.check_id, f.severity, f.title, f.account_name, f.zone_name, f.first_seen, f.resolved_at
  from public.monitor_findings f
  where f.check_id = any(p_checks)
    and (p_accounts is null or f.account_id = any(p_accounts))
    and (p_zones is null or f.zone_id = any(p_zones))
    and case p_kind
      when 'open' then f.resolved_at is null and f.dismissed_at is null
      when 'new' then f.first_seen >= p_since and f.first_seen < p_until and f.dismissed_at is null
      when 'resolved' then f.resolved_at >= p_since and f.resolved_at < p_until
      else false end
  order by f.severity_rank desc, f.last_seen desc
  limit least(greatest(coalesce(p_limit, 20), 1), 200)
$$;

-- Certificates (the certificates check's rows) with at most p_days left, soonest first, and how many there are.
create or replace function public.report_expiring_certs(p_accounts text[], p_zones text[], p_days integer, p_limit integer)
returns table (data jsonb, total bigint)
language sql stable set search_path = public as $$
  select r.data, count(*) over ()
  from public.monitor_rows r
  left join public.monitor_targets t on t.check_id = 'certificates' and t.scope_kind = r.scope_kind and t.scope_id = r.scope_id
  where r.check_id = 'certificates' and r.section = 'certificates' and r.sort <= p_days
    and (p_accounts is null or t.account_id = any(p_accounts))
    and (p_zones is null or (r.scope_kind = 'zone' and r.scope_id = any(p_zones)))
  order by r.sort, r.id
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

-- Each check's coverage within a scope: units, read without problems, failing, never read.
create or replace function public.report_coverage(p_checks text[], p_accounts text[], p_zones text[])
returns table (check_id text, targets bigint, read_ok bigint, failing bigint, never bigint)
language sql stable set search_path = public as $$
  select t.check_id, count(*),
         count(*) filter (where t.last_ok_at is not null and t.last_error is null),
         count(*) filter (where t.last_error is not null),
         count(*) filter (where t.last_run_at is null)
  from public.monitor_targets t
  where t.check_id = any(p_checks)
    and (p_accounts is null or t.account_id = any(p_accounts))
    and (p_zones is null or (t.scope_kind = 'zone' and t.scope_id = any(p_zones)))
  group by t.check_id
$$;

-- The newest failed reads within a scope.
create or replace function public.report_coverage_problems(p_checks text[], p_accounts text[], p_zones text[], p_limit integer)
returns table (check_id text, scope_kind text, scope_id text, account_name text, zone_name text, last_error text, last_run_at timestamptz)
language sql stable set search_path = public as $$
  select t.check_id, t.scope_kind, t.scope_id, t.account_name, t.zone_name, t.last_error, t.last_run_at
  from public.monitor_targets t
  where t.last_error is not null and t.check_id = any(p_checks)
    and (p_accounts is null or t.account_id = any(p_accounts))
    and (p_zones is null or (t.scope_kind = 'zone' and t.scope_id = any(p_zones)))
  order by t.last_run_at desc nulls last
  limit least(greatest(coalesce(p_limit, 20), 1), 200)
$$;

-- The newest run of each of these reports (for the list), without its content.
create or replace function public.report_latest(p_ids uuid[])
returns table (id uuid, definition_id uuid, trigger text, requested_by text, status text, period_start timestamptz, period_end timestamptz,
               since timestamptz, started_at timestamptz, finished_at timestamptz, error text, deliveries jsonb)
language sql stable set search_path = public as $$
  select distinct on (r.definition_id) r.id, r.definition_id, r.trigger, r.requested_by, r.status, r.period_start, r.period_end,
         r.since, r.started_at, r.finished_at, r.error, r.deliveries
  from public.report_runs r where r.definition_id = any(p_ids)
  order by r.definition_id, r.started_at desc
$$;

-- The accounts monitoring knows (for choosing a report's scope), with their zone counts.
create or replace function public.report_accounts()
returns table (account_id text, account_name text, zones bigint)
language sql stable set search_path = public as $$
  select t.account_id, max(t.account_name), count(distinct t.scope_id) filter (where t.scope_kind = 'zone')
  from public.monitor_targets t
  where t.account_id is not null
  group by t.account_id
  order by max(t.account_name), t.account_id
  limit 2000
$$;

alter table public.report_definitions enable row level security;
alter table public.report_runs enable row level security;
alter table public.slack_users enable row level security;
revoke all on public.report_definitions, public.report_runs, public.slack_users from anon, authenticated;
revoke all on function public.report_claim(uuid, timestamptz, timestamptz, text, interval), public.report_start(uuid, text, text, interval),
  public.report_claim_delivery(uuid, text), public.report_delivered(uuid, text, boolean, text),
  public.report_finding_counts(text[], text[], text[], timestamptz, timestamptz), public.report_findings_list(text[], text[], text[], timestamptz, timestamptz, text, integer),
  public.report_expiring_certs(text[], text[], integer, integer), public.report_coverage(text[], text[], text[]),
  public.report_coverage_problems(text[], text[], text[], integer), public.report_latest(uuid[]), public.report_accounts() from public, anon, authenticated;
grant execute on function public.report_claim(uuid, timestamptz, timestamptz, text, interval), public.report_start(uuid, text, text, interval),
  public.report_claim_delivery(uuid, text), public.report_delivered(uuid, text, boolean, text),
  public.report_finding_counts(text[], text[], text[], timestamptz, timestamptz), public.report_findings_list(text[], text[], text[], timestamptz, timestamptz, text, integer),
  public.report_expiring_certs(text[], text[], integer, integer), public.report_coverage(text[], text[], text[]),
  public.report_coverage_problems(text[], text[], text[], integer), public.report_latest(uuid[]), public.report_accounts() to service_role;
