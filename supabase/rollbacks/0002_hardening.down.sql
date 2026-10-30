-- Undoes 0002_hardening.sql: drops the setup claim and gives new objects in `public` Supabase's
-- default grants again. Tables keep row-level security and their revoked grants.
drop table if exists public.setup_claim;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    execute 'alter default privileges for role postgres in schema public grant all on tables to anon, authenticated';
    execute 'alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated';
    execute 'alter default privileges for role postgres in schema public grant all on functions to anon, authenticated';
  end if;
end $$;
