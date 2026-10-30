-- Undoes 0007_worker_versions.sql.
alter table public.workers drop column if exists retire_requested;
drop table if exists public.web_versions;
