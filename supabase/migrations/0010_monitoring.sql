-- Backup Console — monitoring: scheduled checks of the Cloudflare accounts, what they found, the
-- alerts Cloudflare sends to the console, and every notification the console sent (apply after 0009).
-- Rollback: supabase/rollbacks/0010_monitoring.down.sql
-- Only the service role reads these tables (RLS on, no policies), like the rest of the console.

-- The newest result of each check (certificates, posture, drift …), shown by its page.
create table if not exists public.monitor_reports (
  check_id     text primary key,
  data         jsonb not null,
  ran_at       timestamptz not null default now(),
  duration_ms  integer not null default 0,
  error        text
);

-- One problem a check found. `fingerprint` names the same problem across runs, so a finding is
-- updated (last_seen) instead of repeated; a problem that is gone is marked resolved.
create table if not exists public.monitor_findings (
  id            text primary key,
  check_id      text not null,
  severity      text not null check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  title         text not null,
  detail        text not null default '',
  account_id    text,
  account_name  text,
  zone_id       text,
  zone_name     text,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  resolved_at   timestamptz,
  dismissed_at  timestamptz,
  dismissed_by  text,
  notified_at   timestamptz
);
create index if not exists monitor_findings_open_idx on public.monitor_findings (check_id, last_seen desc) where resolved_at is null;

-- Alerts Cloudflare delivered to the console's webhook.
create table if not exists public.cloudflare_alerts (
  id           uuid primary key default gen_random_uuid(),
  received_at  timestamptz not null default now(),
  alert_type   text,
  name         text,
  text         text,
  account_id   text,
  data         jsonb not null
);
create index if not exists cloudflare_alerts_received_idx on public.cloudflare_alerts (received_at desc);

-- Every notification the console sent (Slack, webhook): sent once, never retried.
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  sent_at     timestamptz not null default now(),
  channel     text not null,
  subject     text not null,
  findings    integer not null default 0,
  ok          boolean not null,
  error       text
);
create index if not exists notifications_sent_idx on public.notifications (sent_at desc);

alter table public.monitor_reports enable row level security;
alter table public.monitor_findings enable row level security;
alter table public.cloudflare_alerts enable row level security;
alter table public.notifications enable row level security;
revoke all on public.monitor_reports, public.monitor_findings, public.cloudflare_alerts, public.notifications from anon, authenticated;
