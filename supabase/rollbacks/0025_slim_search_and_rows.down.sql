-- Undoes 0025_slim_search_and_rows.sql: the drift rows go back into zone_search, the search functions
-- are the ones of 0016 again, and monitor_rows gets its search column back (filled from each row).
-- The console version that came with 0025 no longer writes that column: roll the console back too.

-- monitor_rows.search, filled from the rows' data.
alter table public.monitor_rows add column if not exists search text not null default '';
update public.monitor_rows set search = public.monitor_row_text(data);
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
    and (coalesce(p_q, '') = '' or r.search like '%' || lower(p_q) || '%')
  order by r.sort, r.id
  offset greatest(0, coalesce(p_offset, 0)) limit least(20000, greatest(1, coalesce(p_limit, 50)))
$$;
revoke all on function public.monitor_rows_filtered(text, text, text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.monitor_rows_filtered(text, text, text, text, text, text, text, integer, integer) to service_role;
drop function if exists public.monitor_row_text(jsonb);

-- The drift rows, back in zone_search (in their order).
insert into public.zone_search (zone_id, zone_name, account_id, kind, item, path, subject, value, value_norm, subject_norm, ip, source, source_ref, source_at)
select d.zone_id, d.zone_name, d.account_id, e.x->>0, e.x->>1, e.x->>2, coalesce(e.x->>3, ''), e.x->>4, lower(e.x->>4), lower(coalesce(e.x->>3, '')),
       (e.x->>5)::inet, 'drift', d.source_ref, d.source_at
from public.zone_search_drift d, jsonb_array_elements(d.rows) with ordinality as e(x, o)
order by d.zone_id, e.o;

-- The functions of 0016.
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
begin
  if p_zone is null or length(p_zone) > 64 or p_source is null or length(p_source) > 64 or p_at is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'zone_search_replace: invalid arguments';
  end if;
  if p_replace then
    if exists (select 1 from public.zone_search_sources where zone_id = p_zone and source = p_source and source_at > p_at) then
      return query select -1;
      return;
    end if;
    delete from public.zone_search where zone_id = p_zone and source = p_source;
  end if;
  insert into public.zone_search (zone_id, zone_name, account_id, kind, item, path, subject, value, value_norm, subject_norm, ip, source, source_ref, source_at)
  select p_zone, p_zone_name, p_account, left(x.kind, 32), left(x.item, 500), left(x.path, 500), left(coalesce(x.subject, ''), 500), left(x.value, 4000),
         lower(left(x.value, 4000)), lower(left(coalesce(x.subject, ''), 500)), x.ip::inet, p_source, p_ref, p_at
  from jsonb_to_recordset(p_rows) as x(kind text, item text, path text, subject text, value text, ip text)
  where x.kind is not null and x.item is not null and x.path is not null and x.value is not null;
  select count(*) into n from public.zone_search where zone_id = p_zone and source = p_source;
  insert into public.zone_search_sources as t (zone_id, source, zone_name, account_id, source_ref, source_at, rows, indexed_at)
  values (p_zone, p_source, p_zone_name, p_account, p_ref, p_at, n, now())
  on conflict (zone_id, source) do update set zone_name = excluded.zone_name, account_id = coalesce(excluded.account_id, t.account_id),
    source_ref = excluded.source_ref, source_at = excluded.source_at, rows = excluded.rows, indexed_at = excluded.indexed_at;
  return query select n;
end $$;

create or replace function public.zone_search_forget(p_zones text[], p_source text)
returns table (removed integer)
language plpgsql set search_path = public as $$
declare
  n integer;
begin
  delete from public.zone_search where zone_id = any(p_zones) and (p_source is null or source = p_source);
  get diagnostics n = row_count;
  delete from public.zone_search_sources where zone_id = any(p_zones) and (p_source is null or source = p_source);
  return query select n;
end $$;

create or replace function public.zone_search_find(p_q text, p_mode text, p_kinds text[], p_account text, p_zones text[], p_offset integer, p_limit integer)
returns table (zone_id text, zone_name text, account_id text, kind text, path text, subject text, value text, source text, source_ref text, source_at timestamptz, total bigint)
language plpgsql stable set search_path = public as $$
declare
  q text := lower(btrim(coalesce(p_q, '')));
  ip inet;
  arms text[] := '{}';
  filters text := '';
begin
  if length(q) < 1 or length(q) > 200 or p_mode not in ('exact', 'contains') then
    raise exception 'zone_search_find: invalid arguments';
  end if;
  if q ~ '^[0-9a-f:./]+$' and (q ~ '\.' or q ~ ':') then
    begin ip := q::inet; exception when others then ip := null; end;
  end if;
  if p_mode = 'exact' then
    arms := arms || 'left(s.value_norm, 200) = left($1, 200) and s.value_norm = $1'::text || 'left(s.subject_norm, 200) = left($1, 200) and s.subject_norm = $1'::text;
  else
    arms := arms || $a$s.value_norm like '%' || replace(replace(replace($1, '\', '\\'), '%', '\%'), '_', '\_') || '%'$a$::text
                 || $a$s.subject_norm like '%' || replace(replace(replace($1, '\', '\\'), '%', '\%'), '_', '\_') || '%'$a$::text;
  end if;
  if ip is not null then arms := arms || 's.ip <<= $2'::text; end if;
  if p_kinds is not null then filters := filters || ' and s.kind = any($3)'; end if;
  if p_account is not null then filters := filters || ' and s.account_id = $4'; end if;
  if p_zones is not null then filters := filters || ' and s.zone_id = any($5)'; end if;
  return query execute format($f$
    with m as (
      select s.id, s.zone_id, s.zone_name, s.account_id, s.kind, s.path, s.subject, s.value, s.source, s.source_ref, s.source_at
      from public.zone_search s
      where ((%s))%s
      limit 5001
    ), c as (select count(*)::bigint n from m)
    select m.zone_id, m.zone_name, m.account_id, m.kind, m.path, m.subject, m.value, m.source, m.source_ref, m.source_at, c.n
    from m, c order by m.zone_name, m.kind, m.path, m.id offset $6 limit $7$f$, array_to_string(arms, ') or ('), filters)
  using q, ip, p_kinds, p_account, p_zones, greatest(coalesce(p_offset, 0), 0), least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

create or replace function public.zone_search_items(p_zones text[], p_items text[])
returns table (zone_id text, zone_name text, kind text, item text, path text, value text, source text, source_at timestamptz)
language sql stable set search_path = public as $$
  select s.zone_id, s.zone_name, s.kind, s.item, s.path, s.value, s.source, s.source_at
  from public.zone_search s
  where s.zone_id = any(p_zones) and (p_items is null or s.item = any(p_items))
  order by s.zone_id, s.item, s.id
  limit 200000
$$;

revoke all on function public.zone_search_replace(text, text, text, text, text, timestamptz, jsonb, boolean), public.zone_search_forget(text[], text),
  public.zone_search_find(text, text, text[], text, text[], integer, integer), public.zone_search_items(text[], text[]) from public, anon, authenticated;
grant execute on function public.zone_search_replace(text, text, text, text, text, timestamptz, jsonb, boolean), public.zone_search_forget(text[], text),
  public.zone_search_find(text, text, text[], text, text[], integer, integer), public.zone_search_items(text[], text[]) to service_role;

drop table if exists public.zone_search_drift;
