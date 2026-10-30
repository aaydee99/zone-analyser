-- Undoes 0004_worker.sql (needs 0005-0007 rolled back first).
drop table if exists public.worker_call_chunks;
drop table if exists public.worker_calls;
drop table if exists public.workers;
