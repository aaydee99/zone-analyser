-- Backup Console — a worker running older code steps down for a new one (apply after 0006).
--
-- The web side (Vercel) records when each of its versions (git commit) first ran. A worker that
-- started before the current version and runs a different one is asked to stop: it finishes what
-- it is doing, stops, and the next request starts a new worker with the new code.

create table if not exists public.web_versions (
  version     text primary key,
  first_seen  timestamptz not null default now()
);

alter table public.workers add column if not exists retire_requested text;

alter table public.web_versions enable row level security;
revoke all on public.web_versions from anon, authenticated;
