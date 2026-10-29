-- Backup Console — security hardening (apply after 0001).

-- ── Atomic first-run setup ───────────────────────────────────────────────────
-- The console inserts this single row before creating the first super admin;
-- a second concurrent setup request fails on the primary key.
create table if not exists public.setup_claim (
  id         smallint primary key default 1 check (id = 1),
  email      text not null,
  claimed_at timestamptz not null default now()
);
alter table public.setup_claim enable row level security;
revoke all on public.setup_claim from anon, authenticated;

-- ── Future objects are private by default ────────────────────────────────────
-- Supabase grants new objects in `public` to anon/authenticated by default. Revoke
-- that so a table added later without RLS is not readable with the anon key.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
-- Supabase creates objects as the `postgres` role when you use the SQL editor;
-- cover that owner explicitly as well (no-op elsewhere).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    execute 'alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated';
    execute 'alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated';
  end if;
end $$;

-- The enum type and any existing sequences: no access for the API roles either.
revoke all on type public.app_role from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
