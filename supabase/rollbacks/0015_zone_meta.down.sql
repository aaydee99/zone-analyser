-- Undoes 0015_zone_meta.sql (zone tags and owners, favourite and recent zones, saved views are gone;
-- the console answers 503 for those features and everything else keeps working).
drop function if exists public.zone_recent_touch(uuid, text, text, text);
drop function if exists public.zone_meta_findings(text[], text[], text, boolean, text, integer, integer);
drop function if exists public.zone_meta_rename_tag(text, text, text);
drop function if exists public.zone_meta_bulk(jsonb, text[], text[], text, text);
drop function if exists public.zone_meta_all(boolean);
drop function if exists public.zone_meta_tags();
drop function if exists public.zone_meta_match(text[], text, text);
drop index if exists public.monitor_findings_zone_idx;
drop table if exists public.user_saved_views;
drop table if exists public.user_zone_recents;
drop table if exists public.user_zone_favourites;
drop table if exists public.zone_meta;
