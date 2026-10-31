-- Undoes 0019_ops_tools.sql (saved API console queries are lost; running Worker log sessions end
-- when their Cloudflare tail expires).
drop table if exists public.worker_tail_events;
drop table if exists public.worker_tail_sessions;
drop table if exists public.api_saved_queries;
