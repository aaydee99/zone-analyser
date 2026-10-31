-- Undoes 0010_monitoring.sql: deletes check results, findings, received Cloudflare alerts and the notification log.
drop table if exists public.notifications;
drop table if exists public.cloudflare_alerts;
drop table if exists public.monitor_findings;
drop table if exists public.monitor_reports;
