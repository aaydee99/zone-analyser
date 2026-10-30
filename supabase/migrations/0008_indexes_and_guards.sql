-- Backup Console — indexes for the filters the console uses, and a database-side guard for the
-- last super admin (apply after 0007). Rollback: supabase/rollbacks/0008_indexes_and_guards.down.sql

-- Restore history and revert checks filter the audit log by action, newest first.
create index if not exists audit_log_action_at_idx on public.audit_log (action, at desc);
-- The worker purges expired calls, and reads the queue only for calls that have not expired.
create index if not exists worker_calls_expires_idx on public.worker_calls (expires_at);
-- The newest worker heartbeat, and the purge of old workers.
create index if not exists workers_last_seen_idx on public.workers (last_seen desc);
-- Sign-in deletes expired sessions.
create index if not exists sessions_expires_idx on public.sessions (expires_at);

-- ── At least one enabled super admin ─────────────────────────────────────────
-- The console checks this before it demotes, disables or deletes a super admin, but two such
-- changes at the same moment could each see the other one still there. This trigger checks
-- again inside the database, one change at a time (the advisory lock), after the change.
create or replace function public.keep_a_super_admin() returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('public.profiles:super_admin'));
  if exists (select 1 from public.profiles)
     and not exists (select 1 from public.profiles where role = 'super_admin' and not disabled) then
    raise exception 'This is the last super admin' using errcode = 'P0001';
  end if;
  return null;
end $$;

drop trigger if exists profiles_keep_a_super_admin on public.profiles;
create trigger profiles_keep_a_super_admin
  after update of role, disabled or delete on public.profiles
  for each statement execute function public.keep_a_super_admin();

revoke all on function public.keep_a_super_admin() from public, anon, authenticated;
