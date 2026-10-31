-- Backup Console — zone tags and owners, and each user's favourite zones, recent zones and saved views
-- (apply after 0001; the findings filter reads monitor_findings from 0010/0011 when you have them).
-- Rollback: supabase/rollbacks/0015_zone_meta.down.sql
-- Only the service role reads these tables (RLS on, no policies), like the rest of the console.
-- Console data only: nothing here is ever sent to Cloudflare. Without this migration the console
-- still works; the tag, owner, favourite and saved-view features answer 503 naming this file.

-- Tags, owner, contact and notes per zone. Tags are lower-case words like "team:payments" or
-- "env:prod" (checked by the console: src/lib/zone-meta-types.ts), kept sorted and without repeats.
create table if not exists public.zone_meta (
  zone_id       text primary key check (zone_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  zone_name     text not null default '' check (length(zone_name) <= 253),
  account_name  text not null default '' check (length(account_name) <= 200),
  tags          text[] not null default '{}' check (cardinality(tags) <= 30),
  owner         text not null default '' check (length(owner) <= 200),
  contact       text not null default '' check (length(contact) <= 200),
  notes         text not null default '' check (length(notes) <= 2000),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
-- "Zones with all of these tags" (tags @> array[...]) and "zones of this owner" (case-insensitive).
create index if not exists zone_meta_tags_idx on public.zone_meta using gin (tags);
create index if not exists zone_meta_owner_idx on public.zone_meta (lower(owner)) where owner <> '';

-- The zones matching a filter, as one array (one row: not cut by PostgREST's max-rows).
-- p_tags: all of them; p_owner: exactly (any case); p_q: part of the owner, contact, notes or a tag.
-- p_q arrives with LIKE wildcards already removed by the console.
create or replace function public.zone_meta_match(p_tags text[], p_owner text, p_q text)
returns table (zone_ids text[])
language sql stable set search_path = public as $$
  select coalesce(array_agg(m.zone_id order by m.zone_id), '{}')
  from public.zone_meta m
  where (coalesce(cardinality(p_tags), 0) = 0 or m.tags @> p_tags)
    and (coalesce(p_owner, '') = '' or lower(m.owner) = lower(p_owner))
    and (coalesce(p_q, '') = '' or m.owner ilike '%' || p_q || '%' or m.contact ilike '%' || p_q || '%'
         or m.notes ilike '%' || p_q || '%' or array_to_string(m.tags, ' ') ilike '%' || p_q || '%')
$$;

-- Every tag with how many zones carry it, and every owner with how many zones they own (most first).
create or replace function public.zone_meta_tags()
returns table (tags jsonb, owners jsonb)
language sql stable set search_path = public as $$
  select
    coalesce((select jsonb_agg(jsonb_build_object('tag', t, 'count', n) order by n desc, t)
      from (select t, count(*) n from public.zone_meta, unnest(tags) t group by t order by count(*) desc, t limit 5000) x), '[]'),
    coalesce((select jsonb_agg(jsonb_build_object('owner', o, 'count', n) order by n desc, o)
      from (select min(owner) o, count(*) n from public.zone_meta where owner <> '' group by lower(owner) order by count(*) desc, min(owner) limit 2000) y), '[]')
$$;

-- Tags and owner of every zone that has any, as one object { zone id: { t: tags, o: owner } }
-- (p_full adds contact and notes, for the CSV export).
create or replace function public.zone_meta_all(p_full boolean)
returns table (meta jsonb)
language sql stable set search_path = public as $$
  select coalesce(jsonb_object_agg(m.zone_id, case when p_full
    then jsonb_build_object('t', m.tags, 'o', m.owner, 'c', m.contact, 'n', m.notes, 'zn', m.zone_name)
    else jsonb_build_object('t', m.tags, 'o', m.owner) end), '{}')
  from public.zone_meta m
$$;

-- Adds and removes tags on many zones at once (and sets their owner when p_owner is not null).
-- p_zones: [{ "id", "name", "account" }]. Rows left with nothing are dropped. changed: zones whose
-- tags or owner changed.
create or replace function public.zone_meta_bulk(p_zones jsonb, p_add text[], p_remove text[], p_owner text, p_by text)
returns table (changed integer)
language plpgsql set search_path = public as $$
#variable_conflict use_column
declare
  n integer;
  ids text[];
begin
  if p_zones is null or jsonb_typeof(p_zones) <> 'array' or jsonb_array_length(p_zones) > 20000 or length(p_owner) > 200 then
    raise exception 'zone_meta_bulk: invalid arguments';
  end if;
  select coalesce(array_agg(distinct z->>'id'), '{}') into ids from jsonb_array_elements(p_zones) z where z->>'id' is not null;
  insert into public.zone_meta as t (zone_id, zone_name, account_name, updated_by)
  select distinct on (z->>'id') z->>'id', coalesce(z->>'name', ''), coalesce(z->>'account', ''), p_by
  from jsonb_array_elements(p_zones) z where z->>'id' is not null
  on conflict (zone_id) do update set
    zone_name = case when excluded.zone_name <> '' then excluded.zone_name else t.zone_name end,
    account_name = case when excluded.account_name <> '' then excluded.account_name else t.account_name end;
  with next as (
    select m.zone_id, coalesce((select array_agg(distinct x order by x) from unnest(m.tags || coalesce(p_add, '{}')) x
      where x <> all (coalesce(p_remove, '{}'))), '{}') as tags
    from public.zone_meta m where m.zone_id = any (ids)
  )
  update public.zone_meta m set tags = next.tags, owner = coalesce(p_owner, m.owner), updated_at = now(), updated_by = p_by
  from next
  where m.zone_id = next.zone_id and (m.tags is distinct from next.tags or (p_owner is not null and m.owner is distinct from p_owner));
  get diagnostics n = row_count;
  delete from public.zone_meta m where m.zone_id = any (ids) and m.tags = '{}' and m.owner = '' and m.contact = '' and m.notes = '';
  return query select n;
end $$;

-- Renames a tag on every zone (merging it into p_to when that tag exists too); p_to '' removes it.
create or replace function public.zone_meta_rename_tag(p_from text, p_to text, p_by text)
returns table (changed integer)
language plpgsql set search_path = public as $$
#variable_conflict use_column
declare
  n integer;
begin
  if coalesce(p_from, '') = '' or p_to is null or length(p_to) > 64 then
    raise exception 'zone_meta_rename_tag: invalid arguments';
  end if;
  update public.zone_meta m set
    tags = coalesce((select array_agg(distinct x order by x) from unnest(case when p_to = '' then array_remove(m.tags, p_from) else array_replace(m.tags, p_from, p_to) end) x), '{}'),
    updated_at = now(), updated_by = p_by
  where m.tags @> array[p_from];
  get diagnostics n = row_count;
  delete from public.zone_meta m where m.tags = '{}' and m.owner = '' and m.contact = '' and m.notes = '';
  return query select n;
end $$;

-- Monitoring findings limited to some zones (a tag or owner filter), worst first, one page:
-- the same filters as the findings list, with the zone ids in the request body (thousands of ids
-- do not fit in a URL). plpgsql, so this migration applies before 0010 too.
create or replace function public.zone_meta_findings(p_zone_ids text[], p_checks text[], p_severity text, p_dismissed boolean, p_term text, p_offset integer, p_limit integer)
returns table (total bigint, rows jsonb)
language plpgsql stable set search_path = public as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 or p_offset is null or p_offset < 0 then
    raise exception 'zone_meta_findings: invalid arguments';
  end if;
  return query
  with f as (
    select mf.id, mf.check_id, mf.severity, mf.title, mf.detail, mf.account_id, mf.account_name, mf.zone_id, mf.zone_name,
      mf.first_seen, mf.last_seen, mf.resolved_at, mf.dismissed_at, mf.dismissed_by, mf.notified_at, mf.severity_rank
    from public.monitor_findings mf
    where mf.zone_id = any (p_zone_ids) and mf.check_id = any (p_checks) and mf.resolved_at is null
      and (case when p_dismissed then mf.dismissed_at is not null else mf.dismissed_at is null end)
      and (p_severity is null or mf.severity = p_severity)
      and (coalesce(p_term, '') = '' or mf.title ilike '%' || p_term || '%')
  )
  select (select count(*) from f),
    coalesce((select jsonb_agg(to_jsonb(x) - 'severity_rank' order by x.severity_rank desc, x.last_seen desc)
      from (select * from f order by f.severity_rank desc, f.last_seen desc offset p_offset limit p_limit) x), '[]');
end $$;

-- The findings filter above looks findings up by zone.
do $$ begin
  if to_regclass('public.monitor_findings') is not null then
    create index if not exists monitor_findings_zone_idx on public.monitor_findings (zone_id) where resolved_at is null;
  end if;
end $$;

-- Each user's starred zones.
create table if not exists public.user_zone_favourites (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  zone_id       text not null check (zone_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  zone_name     text not null default '' check (length(zone_name) <= 253),
  account_name  text not null default '' check (length(account_name) <= 200),
  created_at    timestamptz not null default now(),
  primary key (user_id, zone_id)
);
create index if not exists user_zone_favourites_user_idx on public.user_zone_favourites (user_id, created_at desc);

-- The last 20 zones each user opened.
create table if not exists public.user_zone_recents (
  user_id       uuid not null references public.profiles (id) on delete cascade,
  zone_id       text not null check (zone_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  zone_name     text not null default '' check (length(zone_name) <= 253),
  account_name  text not null default '' check (length(account_name) <= 200),
  visited_at    timestamptz not null default now(),
  primary key (user_id, zone_id)
);
create index if not exists user_zone_recents_user_idx on public.user_zone_recents (user_id, visited_at desc);

-- Records a visit and keeps only the user's 20 latest.
create or replace function public.zone_recent_touch(p_user uuid, p_zone text, p_name text, p_account text)
returns table (ok boolean)
language plpgsql set search_path = public as $$
begin
  insert into public.user_zone_recents as t (user_id, zone_id, zone_name, account_name, visited_at)
  values (p_user, p_zone, coalesce(left(p_name, 253), ''), coalesce(left(p_account, 200), ''), now())
  on conflict (user_id, zone_id) do update set visited_at = now(), zone_name = excluded.zone_name, account_name = excluded.account_name;
  delete from public.user_zone_recents r where r.user_id = p_user and r.zone_id not in (
    select x.zone_id from public.user_zone_recents x where x.user_id = p_user order by x.visited_at desc limit 20);
  return query select true;
end $$;

-- Each user's named views: a page and its query string (filters), e.g. the zone explorer with tags.
create table if not exists public.user_saved_views (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  path        text not null check (length(path) <= 200 and path ~ '^/console(/[A-Za-z0-9._~-]+)*$'),
  name        text not null check (length(name) between 1 and 80),
  query       text not null default '' check (length(query) <= 2000),
  created_at  timestamptz not null default now(),
  unique (user_id, path, name)
);
create index if not exists user_saved_views_user_idx on public.user_saved_views (user_id, path, created_at desc);

alter table public.zone_meta enable row level security;
alter table public.user_zone_favourites enable row level security;
alter table public.user_zone_recents enable row level security;
alter table public.user_saved_views enable row level security;
revoke all on public.zone_meta, public.user_zone_favourites, public.user_zone_recents, public.user_saved_views from anon, authenticated;
revoke all on function public.zone_meta_match(text[], text, text), public.zone_meta_tags(), public.zone_meta_all(boolean),
  public.zone_meta_bulk(jsonb, text[], text[], text, text), public.zone_meta_rename_tag(text, text, text),
  public.zone_meta_findings(text[], text[], text, boolean, text, integer, integer), public.zone_recent_touch(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.zone_meta_match(text[], text, text), public.zone_meta_tags(), public.zone_meta_all(boolean),
  public.zone_meta_bulk(jsonb, text[], text[], text, text), public.zone_meta_rename_tag(text, text, text),
  public.zone_meta_findings(text[], text[], text, boolean, text, integer, integer), public.zone_recent_touch(uuid, text, text, text)
  to service_role;
