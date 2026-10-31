-- Backup Console — job locks and approval claims shared by every worker (apply after 0012).
-- Each worker already runs one job at a time in its own memory; these rows make that hold across
-- workers too (an old and a new GitHub Actions run during a handover, or a local console and a
-- worker on the same Supabase): a backup or restore of a Cloudflare account takes its lock row
-- first, renews it while it runs and gives it back at the end. A lock whose holder stopped without
-- giving it back runs out on its own (expires_at).
-- An approved request is carried out once: its state moves pending → approved → executing with
-- conditional updates, so a second approver, a second worker or a restarted worker cannot start
-- it again.
-- Rollback: supabase/rollbacks/0013_worker_locks.down.sql
-- Only the service role reads these tables and calls these functions (RLS on, no policies).

create table if not exists public.job_locks (
  key          text primary key check (char_length(key) between 1 and 200),
  -- A random id per worker process (never a secret).
  owner        text not null check (char_length(owner) between 1 and 200),
  -- What holds it, for the refusal message ("backup by ops@example.com").
  what         text not null default '' check (char_length(what) <= 300),
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index if not exists job_locks_expires_idx on public.job_locks (expires_at);

-- An approval request's state as every worker sees it. No row: still pending.
create table if not exists public.approval_states (
  id          text primary key check (id ~ '^[A-Za-z0-9_-]{8,32}$'),
  status      text not null check (status in ('pending', 'approved', 'executing', 'done', 'failed', 'rejected', 'withdrawn', 'expired')),
  updated_by  text,
  updated_at  timestamptz not null default now()
);

-- Takes p_key for p_owner for p_ttl_seconds: when nobody holds it, its lock ran out, or p_owner
-- already holds it (then it is extended). Otherwise answers who holds it, and until when.
create or replace function public.job_lock_acquire(p_key text, p_owner text, p_ttl_seconds integer, p_what text default '')
returns table (acquired boolean, holder text, holder_what text, held_until timestamptz)
language plpgsql volatile set search_path = public as $$
declare
  r public.job_locks;
begin
  insert into public.job_locks as l (key, owner, what, acquired_at, expires_at)
  values (p_key, p_owner, left(coalesce(p_what, ''), 300), now(), now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 0), 1)))
  on conflict (key) do update
    set owner = excluded.owner, what = excluded.what, expires_at = excluded.expires_at,
        acquired_at = case when l.owner = excluded.owner then l.acquired_at else excluded.acquired_at end
    where l.expires_at < now() or l.owner = excluded.owner
  returning * into r;
  if found then
    return query select true, r.owner, r.what, r.expires_at;
    return;
  end if;
  return query select false, l.owner, l.what, l.expires_at from public.job_locks l where l.key = p_key;
end;
$$;

-- Extends a lock p_owner holds. False when it is no longer theirs (it ran out and someone took it).
create or replace function public.job_lock_renew(p_key text, p_owner text, p_ttl_seconds integer)
returns table (renewed boolean)
language plpgsql volatile set search_path = public as $$
begin
  update public.job_locks l set expires_at = now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 0), 1))
  where l.key = p_key and l.owner = p_owner;
  return query select found;
end;
$$;

-- Gives a lock back (only its holder can).
create or replace function public.job_lock_release(p_key text, p_owner text)
returns table (released boolean)
language plpgsql volatile set search_path = public as $$
begin
  delete from public.job_locks l where l.key = p_key and l.owner = p_owner;
  return query select found;
end;
$$;

-- Moves an approval from one of p_from to p_to, only if it is in one of them now ('pending' also
-- matches a request with no row yet). Answers whether it moved, and the state it is in now.
create or replace function public.approval_transition(p_id text, p_from text[], p_to text, p_by text)
returns table (changed boolean, current_status text)
language plpgsql volatile set search_path = public as $$
declare
  now_status text;
begin
  if 'pending' = any(p_from) then
    insert into public.approval_states (id, status, updated_by) values (p_id, p_to, p_by) on conflict (id) do nothing;
    if found then
      return query select true, p_to;
      return;
    end if;
  end if;
  update public.approval_states s set status = p_to, updated_by = p_by, updated_at = now()
  where s.id = p_id and s.status = any(p_from);
  if found then
    return query select true, p_to;
    return;
  end if;
  select s.status into now_status from public.approval_states s where s.id = p_id;
  return query select false, coalesce(now_status, 'pending');
end;
$$;

alter table public.job_locks enable row level security;
alter table public.approval_states enable row level security;
revoke all on public.job_locks, public.approval_states from anon, authenticated;
revoke all on function public.job_lock_acquire(text, text, integer, text), public.job_lock_renew(text, text, integer),
  public.job_lock_release(text, text), public.approval_transition(text, text[], text, text) from public, anon, authenticated;
grant execute on function public.job_lock_acquire(text, text, integer, text), public.job_lock_renew(text, text, integer),
  public.job_lock_release(text, text), public.approval_transition(text, text[], text, text) to service_role;
