-- Backup Console — state the web side (Vercel) shares between its instances, so the pages that need
-- the full zone list or a long Cloudflare read work without the worker:
--   zone_list_snapshot — the last zone list read (every zone the stored tokens can read; no tokens).
--   web_jobs           — long reads (traffic, investigate) started on one instance and polled from
--                        any: progress while running, the sealed result when done.
-- Rollback: supabase/rollbacks/0023_web_shared_reads.down.sql
-- Only the service role reads these tables (RLS on, no policies), like the rest of the console.
-- Without this migration the console still works: the zone list is read from Cloudflare on each
-- server as before, and those long reads go to the worker.

create table if not exists public.zone_list_snapshot (
  id                smallint primary key default 1 check (id = 1),
  -- The list (src/lib/zone-explorer.ts ZoneList) as JSON, gzip-compressed, base64.
  data              text not null,
  zones             integer not null default 0 check (zones >= 0),
  read_at           timestamptz not null,
  saved_at          timestamptz not null default now(),
  -- Set while one server reads the list again in the background, so others don't read it too.
  refreshing_since  timestamptz
);

-- Keeps the newer of two reads (one that finishes late never replaces a newer list).
create or replace function public.zone_list_save(p_data text, p_zones integer, p_read_at timestamptz)
returns boolean
language plpgsql volatile set search_path = public as $$
begin
  insert into public.zone_list_snapshot (id, data, zones, read_at, saved_at, refreshing_since)
  values (1, p_data, p_zones, p_read_at, now(), null)
  on conflict (id) do update set data = excluded.data, zones = excluded.zones, read_at = excluded.read_at, saved_at = now(), refreshing_since = null
    where public.zone_list_snapshot.read_at <= excluded.read_at;
  return found;
end $$;

-- Claims the background re-read: true for one caller until it saves, or for 5 minutes.
create or replace function public.zone_list_claim_refresh()
returns boolean
language plpgsql volatile set search_path = public as $$
begin
  update public.zone_list_snapshot set refreshing_since = now()
  where id = 1 and (refreshing_since is null or refreshing_since < now() - interval '5 minutes');
  return found;
end $$;

create table if not exists public.web_jobs (
  -- SHA-256 (hex) of the read's key: what is read, for which account, zone and month.
  key           text primary key check (key ~ '^[a-f0-9]{64}$'),
  job           uuid not null,
  status        text not null default 'running' check (status in ('running', 'done', 'failed')),
  done          integer not null default 0,
  total         integer not null default 0,
  note          text check (length(note) <= 500),
  started_at    timestamptz not null default now(),
  -- Written every few seconds by the server running the read; a running row that stops changing has lost its server.
  updated_at    timestamptz not null default now(),
  -- When a request last asked about this read (a read nobody asks about is stopped).
  asked_at      timestamptz not null default now(),
  -- Done: until when the result is handed out.
  keep_until    timestamptz,
  -- Done: the result, sealed with AES-256-GCM under the vault server key ({ iv, tag, ct }).
  result        jsonb,
  -- Failed: the status and message the request answers with; error_code 'too_long' sends the read to the worker.
  error_status  integer,
  error         text check (length(error) <= 2000),
  error_code    text
);
create index if not exists web_jobs_updated_idx on public.web_jobs (updated_at);

-- Starts a read under p_job unless one is running (with a heartbeat newer than p_stale_ms); returns
-- the row either way, so a caller that lost the race joins the read that runs. Rows untouched for a
-- day are deleted.
create or replace function public.web_job_claim(p_key text, p_job uuid, p_stale_ms integer)
returns setof public.web_jobs
language plpgsql volatile set search_path = public as $$
begin
  delete from public.web_jobs where updated_at < now() - interval '1 day';
  insert into public.web_jobs (key, job, status, started_at, updated_at, asked_at)
  values (p_key, p_job, 'running', now(), now(), now())
  on conflict (key) do update set job = excluded.job, status = 'running', done = 0, total = 0, note = null,
    started_at = now(), updated_at = now(), asked_at = now(), keep_until = null, result = null,
    error_status = null, error = null, error_code = null
    where public.web_jobs.status <> 'running' or public.web_jobs.updated_at < now() - make_interval(secs => p_stale_ms / 1000.0);
  return query select * from public.web_jobs where key = p_key;
end $$;

alter table public.zone_list_snapshot enable row level security;
alter table public.web_jobs enable row level security;
revoke all on public.zone_list_snapshot, public.web_jobs from anon, authenticated;
revoke all on function public.zone_list_save(text, integer, timestamptz), public.zone_list_claim_refresh(), public.web_job_claim(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.zone_list_save(text, integer, timestamptz), public.zone_list_claim_refresh(), public.web_job_claim(text, uuid, integer) to service_role;
