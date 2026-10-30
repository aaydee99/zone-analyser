-- Undoes 0008_indexes_and_guards.sql.
drop trigger if exists profiles_keep_a_super_admin on public.profiles;
drop function if exists public.keep_a_super_admin();
drop index if exists public.sessions_expires_idx;
drop index if exists public.workers_last_seen_idx;
drop index if exists public.worker_calls_expires_idx;
drop index if exists public.audit_log_action_at_idx;
