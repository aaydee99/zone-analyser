-- Undoes 0016_zone_search.sql (the search index, comparison templates and their results go; the
-- index is rebuilt from backups and monitoring after the migration is applied again). pg_trgm is
-- left installed: other things may use it.
drop function if exists public.zone_search_status();
drop function if exists public.zone_search_items(text[], text[]);
drop function if exists public.zone_search_find(text, text, text[], text, text[], integer, integer);
drop function if exists public.zone_search_forget(text[], text);
drop function if exists public.zone_search_replace(text, text, text, text, text, timestamptz, jsonb, boolean);
drop table if exists public.zone_template_results;
drop table if exists public.zone_templates;
drop table if exists public.zone_search_sources;
drop table if exists public.zone_search;
