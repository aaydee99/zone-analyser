-- Undoes 0012_monitor_claims.sql: unit claims by owner, the per-token queue and per-channel
-- notification marks. No data is lost but who holds a lease and which channel a finding went to;
-- notified_at stays, so nothing is sent again.
drop function if exists public.monitor_due(jsonb, boolean);
drop function if exists public.monitor_claim(jsonb, timestamptz, text);
alter table public.monitor_findings drop column if exists notified_channels;
drop index if exists public.monitor_targets_account_due_idx;
alter table public.monitor_targets drop column if exists lease_owner;
