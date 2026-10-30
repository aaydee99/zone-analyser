-- Undoes 0001_backup_console.sql. WARNING: deletes every console table and its data
-- (users' profiles, sessions, vault, credentials, presets, runs, logs, settings, audit log).
-- Supabase Auth users (auth.users) are not touched. Roll back 0002-0008 first.
drop table if exists public.audit_log;
drop table if exists public.settings;
drop table if exists public.run_logs;
drop table if exists public.runs;
drop table if exists public.presets;
drop table if exists public.credentials;
drop table if exists public.vault;
drop table if exists public.sessions;
drop table if exists public.profiles;
drop type if exists public.app_role;
