-- Undoes 0018_zone_health.sql: the zone health scores (recomputed from monitoring when 0018 is
-- applied again), their triggers, and the indexes for the DNS hygiene and list pages.
drop trigger if exists zone_health_targets_upd on public.monitor_targets;
drop trigger if exists zone_health_targets_ins on public.monitor_targets;
drop trigger if exists zone_health_targets_del on public.monitor_targets;
drop trigger if exists zone_health_findings_upd on public.monitor_findings;
drop trigger if exists zone_health_findings_ins on public.monitor_findings;
drop function if exists public.zone_health_on_targets();
drop function if exists public.zone_health_on_findings();
drop function if exists public.monitor_snapshot_dnssec(text);
drop function if exists public.monitor_rows_accounts(text, text);
drop function if exists public.monitor_rows_filtered(text, text, text, text, text, text, text, integer, integer);
drop function if exists public.zone_health_accounts();
drop function if exists public.zone_health_summary(text, text[]);
drop function if exists public.zone_health_page(text, text[], text, text, integer, integer);
drop function if exists public.zone_health_compute(text[]);
drop index if exists public.monitor_rows_kind_idx;
drop index if exists public.monitor_rows_status_idx;
drop index if exists public.monitor_rows_account_idx;
drop index if exists public.monitor_findings_open_zone_idx;
drop table if exists public.zone_health;
