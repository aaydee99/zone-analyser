-- Backup Console — a smaller database (Supabase Free allows 500 MB), with the same searches, templates
-- and filters. Rollback: supabase/rollbacks/0025_slim_search_and_rows.down.sql
--   1. Drift snapshot rows of the search index (about 36 settings, rulesets and DNS records per zone,
--      three quarters of zone_search) move to zone_search_drift: one row per zone holding all of them
--      as a compressed array, instead of one indexed row each. zone_search_replace sends 'drift' there;
--      zone_search_find, zone_search_items and zone_search_forget read and clear both. The console
--      still builds the rows (src/lib/zone-index.ts snapshotRows), so values are exactly as before.
--   2. monitor_rows loses its `search` column (a lower-case copy of every row's values, only used by the
--      filter box): monitor_row_text(data) builds the same text when a filter runs.
-- Run VACUUM FULL public.zone_search and public.monitor_rows afterwards: deleted rows and the dropped
-- column only become free space once the tables are rewritten.

-- ── 1. Drift snapshot rows: one row per zone ─────────────────────────────────

create table if not exists public.zone_search_drift (
  zone_id     text primary key,
  zone_name   text not null,
  account_id  text,
  source_ref  text,
  source_at   timestamptz not null,
  -- [[kind, item, path, subject, value, ip], …] in index order; ip is null unless the value is an address.
  rows        jsonb not null default '[]'::jsonb
);
create index if not exists zone_search_drift_account_idx on public.zone_search_drift (account_id);
alter table public.zone_search_drift enable row level security;
revoke all on public.zone_search_drift from anon, authenticated;

-- Existing drift rows move over (same order), then leave zone_search.
insert into public.zone_search_drift (zone_id, zone_name, account_id, source_ref, source_at, rows)
select s.zone_id, max(s.zone_name), max(s.account_id), max(s.source_ref), max(s.source_at),
       jsonb_agg(jsonb_build_array(s.kind, s.item, s.path, s.subject, s.value, host(s.ip)) order by s.id)
from public.zone_search s where s.source = 'drift'
group by s.zone_id
on conflict (zone_id) do nothing;
delete from public.zone_search where source = 'drift';

-- The four search functions are dropped first: a database that ran an earlier version of 0016 has
-- them with other return types, which `create or replace` can't change. Their grants are set again below.
drop function if exists public.zone_search_replace(text, text, text, text, text, timestamptz, jsonb, boolean);
drop function if exists public.zone_search_forget(text[], text);
drop function if exists public.zone_search_find(text, text, text[], text, text[], integer, integer);
drop function if exists public.zone_search_items(text[], text[]);

create or replace function public.zone_search_replace(p_zone text, p_zone_name text, p_account text, p_source text, p_ref text, p_at timestamptz, p_rows jsonb, p_replace boolean)
returns table (kept integer)
language plpgsql set search_path = public as $$
declare
  n integer;
  add jsonb;
begin
  if p_zone is null or length(p_zone) > 64 or p_source is null or length(p_source) > 64 or p_at is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'zone_search_replace: invalid arguments';
  end if;
  if p_replace and exists (select 1 from public.zone_search_sources where zone_id = p_zone and source = p_source and source_at > p_at) then
    return query select -1;
    return;
  end if;
  if p_source = 'drift' then
    -- The same limits and checks as zone_search; an address is checked by casting it.
    select coalesce(jsonb_agg(jsonb_build_array(left(x.kind, 32), left(x.item, 500), left(x.path, 500), left(coalesce(x.subject, ''), 500),
             left(x.value, 4000), host(x.ip::inet)) order by x.o), '[]'::jsonb) into add
    from rows from (jsonb_to_recordset(p_rows) as (kind text, item text, path text, subject text, value text, ip text))
         with ordinality as x(kind, item, path, subject, value, ip, o)
    where x.kind is not null and x.item is not null and x.path is not null and x.value is not null;
    insert into public.zone_search_drift as d (zone_id, zone_name, account_id, source_ref, source_at, rows)
    values (p_zone, p_zone_name, p_account, p_ref, p_at, add)
    on conflict (zone_id) do update set zone_name = excluded.zone_name, account_id = coalesce(excluded.account_id, d.account_id),
      source_ref = excluded.source_ref, source_at = excluded.source_at,
      rows = case when p_replace then excluded.rows else d.rows || excluded.rows end;
    select jsonb_array_length(d.rows) into n from public.zone_search_drift d where d.zone_id = p_zone;
  else
    if p_replace then
      delete from public.zone_search where zone_id = p_zone and source = p_source;
    end if;
    insert into public.zone_search (zone_id, zone_name, account_id, kind, item, path, subject, value, value_norm, subject_norm, ip, source, source_ref, source_at)
    select p_zone, p_zone_name, p_account, left(x.kind, 32), left(x.item, 500), left(x.path, 500), left(coalesce(x.subject, ''), 500), left(x.value, 4000),
           lower(left(x.value, 4000)), lower(left(coalesce(x.subject, ''), 500)), x.ip::inet, p_source, p_ref, p_at
    from jsonb_to_recordset(p_rows) as x(kind text, item text, path text, subject text, value text, ip text)
    where x.kind is not null and x.item is not null and x.path is not null and x.value is not null;
    select count(*) into n from public.zone_search where zone_id = p_zone and source = p_source;
  end if;
  insert into public.zone_search_sources as t (zone_id, source, zone_name, account_id, source_ref, source_at, rows, indexed_at)
  values (p_zone, p_source, p_zone_name, p_account, p_ref, p_at, n, now())
  on conflict (zone_id, source) do update set zone_name = excluded.zone_name, account_id = coalesce(excluded.account_id, t.account_id),
    source_ref = excluded.source_ref, source_at = excluded.source_at, rows = excluded.rows, indexed_at = excluded.indexed_at;
  return query select n;
end $$;

-- Drops what a source indexed of these zones (zones the tokens no longer reach).
create or replace function public.zone_search_forget(p_zones text[], p_source text)
returns table (removed integer)
language plpgsql set search_path = public as $$
declare
  n integer;
  m integer := 0;
begin
  delete from public.zone_search where zone_id = any(p_zones) and (p_source is null or source = p_source);
  get diagnostics n = row_count;
  if p_source is null or p_source = 'drift' then
    select coalesce(sum(jsonb_array_length(d.rows)), 0) into m from public.zone_search_drift d where d.zone_id = any(p_zones);
    delete from public.zone_search_drift where zone_id = any(p_zones);
  end if;
  delete from public.zone_search_sources where zone_id = any(p_zones) and (p_source is null or source = p_source);
  return query select n + m;
end $$;

-- One page of matches, from zone_search and the drift rows. p_mode: 'exact' (the whole value, or what
-- it belongs to, lower-case) or 'contains'. An address or range (192.0.2.0/24) also finds every
-- address inside it. At most 5,001 matches are counted (total > 5,000: "5,000 or more"); they are
-- sorted by zone, kind, path.
create or replace function public.zone_search_find(p_q text, p_mode text, p_kinds text[], p_account text, p_zones text[], p_offset integer, p_limit integer)
returns table (zone_id text, zone_name text, account_id text, kind text, path text, subject text, value text, source text, source_ref text, source_at timestamptz, total bigint)
language plpgsql stable set search_path = public as $$
declare
  q text := lower(btrim(coalesce(p_q, '')));
  ip inet;
  arms text[] := '{}';
  darms text[] := '{}';
  filters text := '';
  dfilters text := '';
  -- A drift zone whose rows (as JSON text) can't contain q is skipped without unpacking them. Safe
  -- only when q has nothing JSON escapes (quotes, backslashes, control characters) and no address is asked.
  prefilter boolean;
  like_q text;
begin
  if length(q) < 1 or length(q) > 200 or p_mode not in ('exact', 'contains') then
    raise exception 'zone_search_find: invalid arguments';
  end if;
  if q ~ '^[0-9a-f:./]+$' and (q ~ '\.' or q ~ ':') then
    begin ip := q::inet; exception when others then ip := null; end;
  end if;
  like_q := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  if p_mode = 'exact' then
    arms := arms || 'left(s.value_norm, 200) = left($1, 200) and s.value_norm = $1'::text || 'left(s.subject_norm, 200) = left($1, 200) and s.subject_norm = $1'::text;
    darms := darms || 'lower(e->>4) = $1'::text || 'lower(e->>3) = $1'::text;
  else
    arms := arms || 's.value_norm like $8'::text || 's.subject_norm like $8'::text;
    darms := darms || 'lower(e->>4) like $8'::text || 'lower(e->>3) like $8'::text;
  end if;
  if ip is not null then
    arms := arms || 's.ip <<= $2'::text;
    darms := darms || '(e->>5) is not null and (e->>5)::inet <<= $2'::text;
  end if;
  prefilter := ip is null and q !~ '["\\[:cntrl:]]';
  if p_kinds is not null then filters := filters || ' and s.kind = any($3)'; dfilters := dfilters || ' and (e->>0) = any($3)'; end if;
  if p_account is not null then filters := filters || ' and s.account_id = $4'; dfilters := dfilters || ' and d.account_id = $4'; end if;
  if p_zones is not null then filters := filters || ' and s.zone_id = any($5)'; dfilters := dfilters || ' and d.zone_id = any($5)'; end if;
  if prefilter then dfilters := dfilters || ' and lower(d.rows::text) like $8'; end if;
  return query execute format($f$
    with a as (
      (select s.id, s.zone_id, s.zone_name, s.account_id, s.kind, s.path, s.subject, s.value, s.source, s.source_ref, s.source_at
       from public.zone_search s
       where ((%s))%s
       limit 5001)
      union all
      (select e.o, d.zone_id, d.zone_name, d.account_id, e.x->>0, e.x->>2, e.x->>3, e.x->>4, 'drift'::text, d.source_ref, d.source_at
       from public.zone_search_drift d, jsonb_array_elements(d.rows) with ordinality as e(x, o)
       where ((%s))%s
       limit 5001)
    ), m as (select * from a limit 5001), c as (select count(*)::bigint n from m)
    select m.zone_id, m.zone_name, m.account_id, m.kind, m.path, m.subject, m.value, m.source, m.source_ref, m.source_at, c.n
    from m, c order by m.zone_name, m.kind, m.path, m.id offset $6 limit $7$f$,
    array_to_string(arms, ') or ('), filters,
    replace(array_to_string(darms, ') or ('), 'e->>', 'e.x->>'), replace(dfilters, 'e->>', 'e.x->>'))
  using q, ip, p_kinds, p_account, p_zones, greatest(coalesce(p_offset, 0), 0), least(greatest(coalesce(p_limit, 50), 1), 200), like_q;
end $$;

-- The rows of some zones (and only some items, when given), for comparisons and templates.
create or replace function public.zone_search_items(p_zones text[], p_items text[])
returns table (zone_id text, zone_name text, kind text, item text, path text, value text, source text, source_at timestamptz)
language sql stable set search_path = public as $$
  select t.zone_id, t.zone_name, t.kind, t.item, t.path, t.value, t.source, t.source_at from (
    select s.zone_id, s.zone_name, s.kind, s.item, s.path, s.value, s.source, s.source_at, s.id as o
    from public.zone_search s
    where s.zone_id = any(p_zones) and (p_items is null or s.item = any(p_items))
    union all
    select d.zone_id, d.zone_name, e.x->>0, e.x->>1, e.x->>2, e.x->>4, 'drift'::text, d.source_at, e.o
    from public.zone_search_drift d, jsonb_array_elements(d.rows) with ordinality as e(x, o)
    where d.zone_id = any(p_zones) and (p_items is null or (e.x->>1) = any(p_items))
  ) t
  order by t.zone_id, t.item, t.o
  limit 200000
$$;

revoke all on function public.zone_search_replace(text, text, text, text, text, timestamptz, jsonb, boolean), public.zone_search_forget(text[], text),
  public.zone_search_find(text, text, text[], text, text[], integer, integer), public.zone_search_items(text[], text[]) from public, anon, authenticated;
grant execute on function public.zone_search_replace(text, text, text, text, text, timestamptz, jsonb, boolean), public.zone_search_forget(text[], text),
  public.zone_search_find(text, text, text[], text, text[], integer, integer), public.zone_search_items(text[], text[]) to service_role;

-- ── 2. monitor_rows: the filter text is built when a filter runs ──────────────

-- What the filter box searches: the row's shown values (keys starting with _ left out), lower-case,
-- joined by spaces, at most 2,000 characters (as the console used to store it).
create or replace function public.monitor_row_text(p_data jsonb)
returns text
language sql immutable parallel safe set search_path = public as $$
  select left(lower(coalesce(string_agg(e.value, ' ' order by e.o), '')), 2000)
  from jsonb_each_text(p_data) with ordinality as e(key, value, o)
  where left(e.key, 1) <> '_' and e.value is not null and e.value <> ''
$$;

drop function if exists public.monitor_rows_filtered(text, text, text, text, text, text, text, integer, integer);
create or replace function public.monitor_rows_filtered(p_check text, p_section text, p_account text, p_list text, p_kind text,
  p_status_not text, p_q text, p_offset integer, p_limit integer)
returns table (data jsonb, total bigint)
language sql stable set search_path = public as $$
  select r.data, count(*) over ()
  from public.monitor_rows r
  where r.check_id = p_check and r.section = p_section
    and (p_account is null or r.data->>'accountId' = p_account)
    and (p_list is null or r.data->>'list' = p_list)
    and (p_kind is null or r.data->>'kind' = p_kind)
    and (p_status_not is null or r.data->>'status' is distinct from p_status_not)
    and (coalesce(p_q, '') = '' or public.monitor_row_text(r.data) like '%' || lower(p_q) || '%')
  order by r.sort, r.id
  offset greatest(0, coalesce(p_offset, 0)) limit least(20000, greatest(1, coalesce(p_limit, 50)))
$$;
revoke all on function public.monitor_rows_filtered(text, text, text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.monitor_rows_filtered(text, text, text, text, text, text, text, integer, integer) to service_role;

alter table public.monitor_rows drop column if exists search;

revoke all on function public.monitor_row_text(jsonb) from public, anon, authenticated;
grant execute on function public.monitor_row_text(jsonb) to service_role;
