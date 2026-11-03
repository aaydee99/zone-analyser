-- Undoes 0024_retention.sql: stops the hourly deletion and drops its policy. Rows already deleted
-- stay deleted. pg_cron itself is left installed (other jobs may use it).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('castellan-retention');
  end if;
exception when others then
  raise notice 'No castellan-retention job to remove (%)', sqlerrm;
end $$;
drop function if exists public.retention_purge(integer);
drop table if exists public.retention_policy;
