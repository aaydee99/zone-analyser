-- Undoes 0020_reports.sql (report definitions, every report made, and the Slack command allow-list
-- are deleted; the monitoring tables keep their data).
drop function if exists public.report_accounts();
drop function if exists public.report_latest(uuid[]);
drop function if exists public.report_coverage_problems(text[], text[], text[], integer);
drop function if exists public.report_coverage(text[], text[], text[]);
drop function if exists public.report_expiring_certs(text[], text[], integer, integer);
drop function if exists public.report_findings_list(text[], text[], text[], timestamptz, timestamptz, text, integer);
drop function if exists public.report_finding_counts(text[], text[], text[], timestamptz, timestamptz);
drop function if exists public.report_delivered(uuid, text, boolean, text);
drop function if exists public.report_claim_delivery(uuid, text);
drop function if exists public.report_start(uuid, text, text, interval);
drop function if exists public.report_claim(uuid, timestamptz, timestamptz, text, interval);
drop index if exists public.monitor_targets_failing_idx;
drop index if exists public.monitor_findings_resolved_at_idx;
drop index if exists public.monitor_findings_first_seen_idx;
drop table if exists public.slack_users;
drop table if exists public.report_runs;
drop table if exists public.report_definitions;
