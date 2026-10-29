-- Backup Console — the worker's records survive a fresh disk (apply after 0004).
--
-- A worker on Cloudflare Containers (or any host whose disk is wiped on restart) keeps copies of
-- its records here: approval requests (approvals/<id>.json) and restore history
-- (restore-history/<id>.json). Every save is copied here; on start the worker writes them back
-- to its data folder before it takes any call. Records hold no secrets.

create table if not exists public.state_files (
  path        text primary key check (path ~ '^[a-z-]+/[A-Za-z0-9_-]{1,64}\.json$'),
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.state_files enable row level security;
revoke all on public.state_files from anon, authenticated;
