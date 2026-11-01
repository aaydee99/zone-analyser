-- Backup Console — indexes on the foreign keys that point at profiles (apply after 0001).
-- Rollback: supabase/rollbacks/0022_fk_indexes.down.sql
-- Deleting a user sets these columns to null (on delete set null); without an index each delete
-- scans the whole, ever-growing audit log. Plain `create index` like 0008, so the file runs as one
-- script in the SQL editor. It briefly blocks writes to these tables while it builds; with a very
-- large audit log, run instead, on its own (not in a transaction):
--   create index concurrently if not exists audit_log_actor_idx on public.audit_log (actor_id);

create index if not exists audit_log_actor_idx on public.audit_log (actor_id);
create index if not exists runs_started_by_idx on public.runs (started_by);
create index if not exists credentials_created_by_idx on public.credentials (created_by);
