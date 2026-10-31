-- Undoes 0013_worker_locks.sql: deletes the shared job locks and the approval states. Jobs that run
-- right now keep their in-memory lock; requests keep their own record (approvals/<id>.json).
drop function if exists public.approval_transition(text, text[], text, text);
drop function if exists public.job_lock_release(text, text);
drop function if exists public.job_lock_renew(text, text, integer);
drop function if exists public.job_lock_acquire(text, text, integer, text);
drop table if exists public.approval_states;
drop index if exists public.job_locks_expires_idx;
drop table if exists public.job_locks;
