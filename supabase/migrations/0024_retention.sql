-- Backup Console — automatic deletion of old data, so the database stays small (Supabase Free
-- allows 500 MB). Rollback: supabase/rollbacks/0024_retention.down.sql
--   retention_policy  — how many days each kind of old data is kept; edit `days` to change it
--                       (null keeps it for ever). Changes apply on the next run.
--   retention_purge() — deletes what is past its policy, plus housekeeping (expired queue calls,
--                       nonces, rate-limit windows, finished reads, stopped log tails, old workers),
--                       at most p_batch rows per kind per run so a run stays short; the next one
--                       carries on. Returns how many rows went per kind.
-- It runs every hour inside the database when pg_cron is available (Supabase has it), and also
-- from the worker every hour while it runs. Never deleted: open findings, running runs, audits
-- and reports; the latest audit of each zone; the newest report of each definition; anything that
-- is configuration (credentials, presets, tags, monitoring targets, users).
-- Only the service role may run it (and pg_cron, as the database owner).

create table if not exists public.retention_policy (
  item  text primary key,
  days  integer check (days is null or days between 1 and 3650),
  note  text not null default ''
);
insert into public.retention_policy (item, days, note) values
  ('audit_log',          365, 'The console audit log (sign-ins, changes, downloads, refusals)'),
  ('runs',               365, 'Finished backup and restore runs (their log lines go with them)'),
  ('run_logs',            30, 'Log lines of finished runs; the run and its summary stay'),
  ('notifications',       90, 'Monitoring notifications sent (Slack, webhook)'),
  ('cloudflare_alerts',   90, 'Cloudflare alerts received by the webhook'),
  ('monitor_findings',    90, 'Findings resolved this long ago; open ones are kept'),
  ('sessions',             1, 'Sign-in sessions this long after they expired'),
  ('zone_audits',         90, 'Security audits; the latest audit of each zone is always kept'),
  ('report_runs',        180, 'Report runs; the newest of each report is always kept')
on conflict (item) do nothing;

create or replace function public.retention_purge(p_batch integer default 20000)
returns table (item text, deleted bigint)
language plpgsql volatile set search_path = public as $$
declare
  n bigint;
  d integer;
  lim integer := greatest(100, least(coalesce(p_batch, 20000), 200000));
  cutoff timestamptz;
begin
  -- Policy kinds (days null: kept for ever).
  select p.days into d from public.retention_policy p where p.item = 'audit_log';
  if d is not null then
    cutoff := now() - make_interval(days => d);
    delete from public.audit_log where id in (select a.id from public.audit_log a where a.at < cutoff limit lim);
    get diagnostics n = row_count; item := 'audit_log'; deleted := n; return next;
  end if;

  select p.days into d from public.retention_policy p where p.item = 'run_logs';
  if d is not null then
    cutoff := now() - make_interval(days => d);
    delete from public.run_logs where id in (
      select l.id from public.run_logs l join public.runs r on r.id = l.run_id
      where r.status <> 'running' and coalesce(r.ended_at, r.started_at) < cutoff limit lim);
    get diagnostics n = row_count; item := 'run_logs'; deleted := n; return next;
  end if;

  select p.days into d from public.retention_policy p where p.item = 'runs';
  if d is not null then
    cutoff := now() - make_interval(days => d);
    delete from public.runs where id in (
      select r.id from public.runs r where r.status <> 'running' and coalesce(r.ended_at, r.started_at) < cutoff limit greatest(1, lim / 100));
    get diagnostics n = row_count; item := 'runs'; deleted := n; return next;
  end if;

  select p.days into d from public.retention_policy p where p.item = 'notifications';
  if d is not null then
    cutoff := now() - make_interval(days => d);
    delete from public.notifications where id in (select x.id from public.notifications x where x.sent_at < cutoff limit lim);
    get diagnostics n = row_count; item := 'notifications'; deleted := n; return next;
  end if;

  select p.days into d from public.retention_policy p where p.item = 'cloudflare_alerts';
  if d is not null then
    cutoff := now() - make_interval(days => d);
    delete from public.cloudflare_alerts where id in (select x.id from public.cloudflare_alerts x where x.received_at < cutoff limit lim);
    get diagnostics n = row_count; item := 'cloudflare_alerts'; deleted := n; return next;
  end if;

  select p.days into d from public.retention_policy p where p.item = 'monitor_findings';
  if d is not null then
    cutoff := now() - make_interval(days => d);
    delete from public.monitor_findings where id in (
      select f.id from public.monitor_findings f where f.resolved_at is not null and f.resolved_at < cutoff limit lim);
    get diagnostics n = row_count; item := 'monitor_findings'; deleted := n; return next;
  end if;

  select p.days into d from public.retention_policy p where p.item = 'sessions';
  if d is not null then
    cutoff := now() - make_interval(days => d);
    delete from public.sessions where token_hash in (select s.token_hash from public.sessions s where s.expires_at < cutoff limit lim);
    get diagnostics n = row_count; item := 'sessions'; deleted := n; return next;
  end if;

  select p.days into d from public.retention_policy p where p.item = 'zone_audits';
  if d is not null then
    cutoff := now() - make_interval(days => d);
    delete from public.zone_audits where id in (
      select z.id from public.zone_audits z where z.started_at < cutoff and not z.latest and z.status <> 'running' limit greatest(1, lim / 100));
    get diagnostics n = row_count; item := 'zone_audits'; deleted := n; return next;
  end if;

  select p.days into d from public.retention_policy p where p.item = 'report_runs';
  if d is not null then
    cutoff := now() - make_interval(days => d);
    delete from public.report_runs where id in (
      select r.id from public.report_runs r
      where r.started_at < cutoff and r.status <> 'running'
        and r.id <> (select y.id from public.report_runs y where y.definition_id = r.definition_id order by y.started_at desc limit 1)
      limit greatest(1, lim / 100));
    get diagnostics n = row_count; item := 'report_runs'; deleted := n; return next;
  end if;

  -- Housekeeping: short-lived rows whose use is over (fixed, not in the policy).
  delete from public.worker_calls where id in (select c.id from public.worker_calls c where c.expires_at < now() - interval '10 minutes' limit lim);
  get diagnostics n = row_count; item := 'worker_calls'; deleted := n; return next;
  delete from public.relay_calls_used where call_id in (select c.call_id from public.relay_calls_used c where c.expires_at < now() limit lim);
  get diagnostics n = row_count; item := 'relay_calls_used'; deleted := n; return next;
  delete from public.rate_limits where key in (select r.key from public.rate_limits r where r.reset_at < now() - interval '1 hour' limit lim);
  get diagnostics n = row_count; item := 'rate_limits'; deleted := n; return next;
  delete from public.web_jobs where key in (select j.key from public.web_jobs j where j.updated_at < now() - interval '1 day' limit lim);
  get diagnostics n = row_count; item := 'web_jobs'; deleted := n; return next;
  delete from public.worker_tail_sessions where id in (
    select t.id from public.worker_tail_sessions t
    where (t.status = 'stopped' and t.stopped_at < now() - interval '1 day') or t.expires_at < now() - interval '1 day' limit greatest(1, lim / 100));
  get diagnostics n = row_count; item := 'worker_tail_sessions'; deleted := n; return next;
  delete from public.workers where id in (select w.id from public.workers w where w.last_seen < now() - interval '7 days' limit lim);
  get diagnostics n = row_count; item := 'workers'; deleted := n; return next;
end $$;

alter table public.retention_policy enable row level security;
revoke all on public.retention_policy from anon, authenticated;
revoke all on function public.retention_purge(integer) from public, anon, authenticated;
grant execute on function public.retention_purge(integer) to service_role;

-- Every hour at :17, inside the database (pg_cron). Where pg_cron can't be enabled, nothing is
-- scheduled here and the worker runs it while it runs (src/lib/worker-loop.ts).
do $$
begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then
    begin
      create extension if not exists pg_cron;
    exception when others then
      raise notice 'pg_cron is not available here: the worker runs retention_purge() every hour instead';
    end;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('castellan-retention', '17 * * * *', 'select public.retention_purge()');
  end if;
exception when others then
  raise notice 'Could not schedule retention_purge() with pg_cron (%): the worker runs it every hour instead', sqlerrm;
end $$;
