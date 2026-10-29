-- Backup Console — start the worker on demand (apply after 0005).
--
-- When the worker runs on GitHub Actions it is not always on: the web side (Vercel) starts it
-- when someone needs it, and it stops itself when idle. This row records the last start request,
-- so many page loads at once ask GitHub only once.

create table if not exists public.worker_wakeups (
  id            smallint primary key default 1 check (id = 1),
  requested_at  timestamptz not null,
  requested_by  text,
  result        text
);

alter table public.worker_wakeups enable row level security;
revoke all on public.worker_wakeups from anon, authenticated;
