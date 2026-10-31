-- Backup Console — operator tools: saved queries of the read-only API console, and live Worker
-- log sessions with the events they received (apply after 0010–0014).
-- Rollback: supabase/rollbacks/0019_ops_tools.down.sql
-- Only the service role reads these tables (RLS on, no policies), like the rest of the console.
-- Without this migration the API console still runs queries (it cannot save them) and live Worker
-- logs answer 503 naming this file.

-- A user's saved API console paths ({account_id} / {zone_id} placeholders kept). Never a response.
create table if not exists public.api_saved_queries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  name        text not null check (length(name) between 1 and 100),
  path        text not null check (length(path) between 1 and 1024),
  created_at  timestamptz not null default now()
);
create index if not exists api_saved_queries_user_idx on public.api_saved_queries (user_id, created_at desc);

-- One live Worker log session (a Cloudflare tail). The worker process that holds its WebSocket is
-- `owner`; any worker can end it. `tail_sealed` is Cloudflare's tail id, encrypted with the server
-- key (the WebSocket URL is never stored). Stopped sessions are deleted after a few minutes.
create table if not exists public.worker_tail_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  account_id      text not null,
  script          text not null,
  owner           text not null,
  status          text not null default 'starting' check (status in ('starting', 'running', 'stopping', 'stopped')),
  reason          text,
  filters         jsonb not null default '{}'::jsonb,
  tail_sealed     jsonb,
  events          integer not null default 0,
  dropped         integer not null default 0,
  started_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  viewer_seen_at  timestamptz not null default now(),
  owner_seen_at   timestamptz not null default now(),
  stopped_at      timestamptz
);
create index if not exists worker_tail_sessions_user_idx on public.worker_tail_sessions (user_id, started_at desc);
create index if not exists worker_tail_sessions_live_idx on public.worker_tail_sessions (owner_seen_at) where status <> 'stopped';
create index if not exists worker_tail_sessions_stopped_idx on public.worker_tail_sessions (stopped_at) where status = 'stopped';
create index if not exists worker_tail_sessions_expires_idx on public.worker_tail_sessions (expires_at);

-- The events of a running session, short form (no request headers or client IPs). Deleted when the
-- session stops, and with it.
create table if not exists public.worker_tail_events (
  session_id  uuid not null references public.worker_tail_sessions (id) on delete cascade,
  seq         integer not null,
  at          timestamptz not null,
  data        jsonb not null,
  primary key (session_id, seq)
);

alter table public.api_saved_queries enable row level security;
alter table public.worker_tail_sessions enable row level security;
alter table public.worker_tail_events enable row level security;
revoke all on public.api_saved_queries, public.worker_tail_sessions, public.worker_tail_events from anon, authenticated;
