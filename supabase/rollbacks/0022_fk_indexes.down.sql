-- Undoes 0022_fk_indexes.sql.
drop index if exists public.credentials_created_by_idx;
drop index if exists public.runs_started_by_idx;
drop index if exists public.audit_log_actor_idx;
