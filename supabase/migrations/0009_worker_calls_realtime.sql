-- Backup Console — the worker picks up queued calls as soon as they are queued (apply after 0008).
-- Rollback: supabase/rollbacks/0009_worker_calls_realtime.down.sql
--
-- Supabase Realtime tells the worker about each new row in worker_calls, instead of the worker
-- asking every 100–250 ms. Only the service role (the worker) receives the rows: RLS is on and there
-- are no policies, and the requests in them are sealed. Without this the worker keeps polling.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'worker_calls') then
    alter publication supabase_realtime add table public.worker_calls;
  end if;
end $$;

-- The worker claims every queued call in one statement.
create index if not exists worker_calls_queued_idx on public.worker_calls (created_at) where status = 'queued';
