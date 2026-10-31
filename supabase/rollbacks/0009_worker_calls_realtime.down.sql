-- Undoes 0009_worker_calls_realtime.sql (the worker goes back to polling only).
drop index if exists public.worker_calls_queued_idx;
do $$
begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'worker_calls') then
    alter publication supabase_realtime drop table public.worker_calls;
  end if;
end $$;
