-- Undoes 0023_web_shared_reads.sql (the stored zone list and the web side's reads in progress are
-- deleted; the console reads the zone list on each server again, and long reads go to the worker).
drop function if exists public.web_job_claim(text, uuid, integer);
drop function if exists public.zone_list_claim_refresh();
drop function if exists public.zone_list_save(text, integer, timestamptz);
drop table if exists public.web_jobs;
drop table if exists public.zone_list_snapshot;
