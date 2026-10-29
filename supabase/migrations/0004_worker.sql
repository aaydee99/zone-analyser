-- Backup Console — a worker runs the jobs (apply after 0003).
--
-- On Vercel the console cannot run Terraform, keep files or hold long jobs, and its outgoing
-- IP changes. A worker (the same console, started with `npm run worker` on a machine or
-- container with a fixed IP) does that work: the Vercel side signs a request, queues it here,
-- and the worker runs it on its own server and writes back the answer. Requests and answers
-- are sealed (AES-256-GCM, vault server key) and deleted as soon as they are read.
-- Only the service role can read these tables.

-- Workers announce themselves every few seconds.
create table if not exists public.workers (
  id          text primary key,
  hostname    text not null,
  public_ip   text,
  version     text,
  platform    text,
  tools       jsonb,
  started_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

-- One API call the Vercel side hands to a worker.
create table if not exists public.worker_calls (
  id          uuid primary key default gen_random_uuid(),
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  request     jsonb not null,
  response    jsonb,
  -- Large answers (downloads) are split into worker_call_chunks.
  chunks      integer not null default 0,
  error       text,
  worker_id   text,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  done_at     timestamptz,
  expires_at  timestamptz not null
);
create index if not exists worker_calls_queue_idx on public.worker_calls (status, created_at);

create table if not exists public.worker_call_chunks (
  call_id  uuid not null references public.worker_calls (id) on delete cascade,
  seq      integer not null,
  data     jsonb not null,
  primary key (call_id, seq)
);

alter table public.workers enable row level security;
alter table public.worker_calls enable row level security;
alter table public.worker_call_chunks enable row level security;
revoke all on public.workers, public.worker_calls, public.worker_call_chunks from anon, authenticated;
