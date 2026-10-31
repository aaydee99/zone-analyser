-- Undoes 0011_monitor_queue.sql: deletes the monitoring queue, per-target results and rows, and the
-- drift snapshots (baselines start again from the next check). Findings are kept.
drop function if exists public.monitor_accept_baseline(text, text);
drop function if exists public.monitor_open_counts();
drop function if exists public.monitor_coverage();
drop function if exists public.monitor_totals(text);
drop index if exists public.monitor_findings_unsent_idx;
drop index if exists public.monitor_findings_account_idx;
drop index if exists public.monitor_findings_zone_idx;
drop index if exists public.monitor_findings_rank_idx;
alter table public.monitor_findings drop column if exists severity_rank;
drop table if exists public.monitor_snapshots;
drop table if exists public.monitor_rows;
drop table if exists public.monitor_results;
drop table if exists public.monitor_targets;
