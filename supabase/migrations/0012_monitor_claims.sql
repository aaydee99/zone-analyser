-- Backup Console — monitoring with more than one worker (apply after 0011): a unit is taken with a
-- conditional update, so two workers never run it at once; due units are picked per API token, so
-- one paused or busy token cannot fill the queue's window; and a finding is claimed before it is
-- sent, per channel, so it is sent once and a failed send is tried again.
-- Rollback: supabase/rollbacks/0012_monitor_claims.down.sql

-- Which worker holds a unit's lease (a random id per worker process).
alter table public.monitor_targets add column if not exists lease_owner text;
-- Due units of one account, hand-started first, then worst overdue.
create index if not exists monitor_targets_account_due_idx on public.monitor_targets (account_id, priority desc, next_due_at);

-- The channels ('slack', 'webhook') a finding was delivered to. notified_at is set when a worker
-- claims a finding for sending; it is cleared again if a channel it should go to failed.
alter table public.monitor_findings add column if not exists notified_channels text[] not null default '{}';

-- Takes the given units for p_owner until p_until — only those no one holds (no lease, or a lease
-- that ran out). Returns the units taken: a unit another worker took in the meantime is left out.
-- p_units: [{"check_id": …, "scope_kind": …, "scope_id": …}, …]
create or replace function public.monitor_claim(p_units jsonb, p_until timestamptz, p_owner text)
returns setof public.monitor_targets
language sql volatile set search_path = public as $$
  update public.monitor_targets t set lease_until = p_until, lease_owner = p_owner
  from (select distinct u.check_id, u.scope_kind, u.scope_id
        from jsonb_to_recordset(coalesce(p_units, '[]'::jsonb)) as u(check_id text, scope_kind text, scope_id text)) u
  where t.check_id = u.check_id and t.scope_kind = u.scope_kind and t.scope_id = u.scope_id
    and (t.lease_until is null or t.lease_until < now())
  returning t.*
$$;

-- Up to n due, unleased zone and account units per token ("lane"), hand-started first, then worst
-- overdue. Each lane names the accounts its token reads. Returns each unit as JSON with its lane.
-- p_lanes: [{"lane": …, "accounts": ["<account id>", …], "n": 10}, …]
create or replace function public.monitor_due(p_lanes jsonb, p_hand_only boolean)
returns table (lane text, unit jsonb)
language sql stable set search_path = public as $$
  select l.lane, to_jsonb(d)
  from jsonb_to_recordset(coalesce(p_lanes, '[]'::jsonb)) as l(lane text, accounts jsonb, n integer)
  cross join lateral (
    select x.* from (
      select y.* from (select distinct a.id from jsonb_array_elements_text(coalesce(l.accounts, '[]'::jsonb)) a(id)) a
      cross join lateral (
        select t.* from public.monitor_targets t
        where t.account_id = a.id and t.scope_kind <> 'global' and t.next_due_at <= now()
          and (not coalesce(p_hand_only, false) or t.priority > 0)
          and (t.lease_until is null or t.lease_until < now())
        order by t.priority desc, t.next_due_at
        limit greatest(coalesce(l.n, 0), 0)
      ) y
    ) x
    order by x.priority desc, x.next_due_at
    limit greatest(coalesce(l.n, 0), 0)
  ) d
$$;

revoke all on function public.monitor_claim(jsonb, timestamptz, text), public.monitor_due(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.monitor_claim(jsonb, timestamptz, text), public.monitor_due(jsonb, boolean) to service_role;
