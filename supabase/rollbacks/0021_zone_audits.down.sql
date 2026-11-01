-- Undoes 0021_zone_audits.sql (every stored security audit is deleted).
drop function if exists public.zone_audit_latest(text, text, integer, integer);
drop function if exists public.zone_audit_start(text, text, text, text, integer);
drop table if exists public.zone_audits;
