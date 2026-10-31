-- Backup Console — search across every zone ("where is this used?") and zone comparisons with
-- templates (apply after 0011). Everything here is filled from data the console already stores:
-- backups (.tf files), drift snapshots and monitoring results. Nothing is read from Cloudflare.
-- Rollback: supabase/rollbacks/0016_zone_search.down.sql
-- Only the service role reads these tables (RLS on, no policies), like the rest of the console.

-- pg_trgm lets "contains" searches use an index. Supabase has it (in the extensions schema); where it
-- cannot be created, searches still work, without that index.
do $$
begin
  begin
    create extension if not exists pg_trgm with schema extensions;
  exception when others then
    begin
      create extension if not exists pg_trgm;
    exception when others then
      raise notice 'pg_trgm is not available: contains-searches will not use an index';
    end;
  end;
end $$;

-- One fact about a zone: a DNS record and its content, a setting and its value, a rule's expression …
-- `item` names the same thing in every zone (for comparisons); `path` is how it is shown.
create table if not exists public.zone_search (
  id            bigint generated always as identity primary key,
  zone_id       text not null,
  zone_name     text not null,
  account_id    text,
  kind          text not null,
  item          text not null,
  path          text not null,
  subject       text not null default '',
  value         text not null,
  -- Lower-case copies the searches use.
  value_norm    text not null,
  subject_norm  text not null default '',
  -- The value as an address (A / AAAA records …), for searches by range.
  ip            inet,
  -- 'backup', 'drift' or 'monitor:<check>', and which backup folder or run it came from.
  source        text not null,
  source_ref    text,
  source_at     timestamptz not null
);
create index if not exists zone_search_zone_idx on public.zone_search (zone_id, source);
create index if not exists zone_search_item_idx on public.zone_search (item, zone_id);
create index if not exists zone_search_account_idx on public.zone_search (account_id);
create index if not exists zone_search_kind_idx on public.zone_search (kind);
create index if not exists zone_search_value_idx on public.zone_search (left(value_norm, 200));
create index if not exists zone_search_subject_idx on public.zone_search (left(subject_norm, 200));
create index if not exists zone_search_ip_idx on public.zone_search (ip) where ip is not null;

-- The trigram indexes, with pg_trgm's operator class from whichever schema it is in.
do $$
declare
  s text;
begin
  select n.nspname into s from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm';
  if s is not null then
    execute format('create index if not exists zone_search_value_trgm on public.zone_search using gin (value_norm %I.gin_trgm_ops)', s);
    execute format('create index if not exists zone_search_subject_trgm on public.zone_search using gin (subject_norm %I.gin_trgm_ops)', s);
  end if;
end $$;

-- What is indexed of each zone, per source: the newest backup folder or snapshot, and when.
create table if not exists public.zone_search_sources (
  zone_id     text not null,
  source      text not null,
  zone_name   text not null,
  account_id  text,
  source_ref  text,
  source_at   timestamptz not null,
  rows        integer not null default 0,
  indexed_at  timestamptz not null default now(),
  primary key (zone_id, source)
);
create index if not exists zone_search_sources_name_idx on public.zone_search_sources (lower(zone_name));
create index if not exists zone_search_sources_account_idx on public.zone_search_sources (account_id);

-- Replaces (p_replace) or adds to a zone's rows from one source, in one transaction. An older copy
-- never replaces a newer one (a backup indexed late after a newer one): -1 then, else the rows kept.
-- p_rows: [{kind, item, path, subject, value, ip}].
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

-- Drops what a source indexed of these zones (zones the tokens no longer reach).
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

-- One page of matches. p_mode: 'exact' (the whole value, or what it belongs to, lower-case) or
-- 'contains'. An address or range (192.0.2.0/24) also finds every address inside it. At most
-- 5,001 matches are counted (total > 5,000: "5,000 or more"); they are sorted by zone, kind, path.
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

-- The rows of some zones (and only some items, when given), for comparisons and templates.
create or replace function public.zone_search_items(p_zones text[], p_items text[])
returns table (zone_id text, zone_name text, kind text, item text, path text, value text, source text, source_at timestamptz)
language sql stable set search_path = public as $$
  select s.zone_id, s.zone_name, s.kind, s.item, s.path, s.value, s.source, s.source_at
  from public.zone_search s
  where s.zone_id = any(p_zones) and (p_items is null or s.item = any(p_items))
  order by s.zone_id, s.item, s.id
  limit 200000
$$;

-- What the index holds: zones and rows per source, and the newest data of each.
create or replace function public.zone_search_status()
returns table (source text, zones bigint, rows bigint, newest timestamptz, oldest timestamptz)
language sql stable set search_path = public as $$
  select s.source, count(*)::bigint, coalesce(sum(s.rows), 0)::bigint, max(s.source_at), min(s.source_at)
  from public.zone_search_sources s group by s.source order by s.source
$$;

-- Templates: a named baseline of expected values, and each zone's gaps against it (computed from the
-- index, kept until the template or the index changes).
create table if not exists public.zone_templates (
  id                text primary key default gen_random_uuid()::text,
  name              text not null,
  description       text not null default '',
  source_zone_id    text,
  source_zone_name  text,
  items             jsonb not null default '[]'::jsonb,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_by        text,
  updated_at        timestamptz not null default now()
);
create unique index if not exists zone_templates_name_idx on public.zone_templates (lower(name));

create table if not exists public.zone_template_results (
  template_id  text not null references public.zone_templates (id) on delete cascade,
  zone_id      text not null,
  zone_name    text not null,
  account_id   text,
  gaps         integer not null default 0,
  checked      integer not null default 0,
  details      jsonb not null default '[]'::jsonb,
  computed_at  timestamptz not null default now(),
  primary key (template_id, zone_id)
);
create index if not exists zone_template_results_page_idx on public.zone_template_results (template_id, gaps desc, zone_name);
create index if not exists zone_template_results_account_idx on public.zone_template_results (template_id, account_id);

alter table public.zone_search enable row level security;
alter table public.zone_search_sources enable row level security;
alter table public.zone_templates enable row level security;
alter table public.zone_template_results enable row level security;
revoke all on public.zone_search, public.zone_search_sources, public.zone_templates, public.zone_template_results from anon, authenticated;
revoke all on function public.zone_search_replace(text, text, text, text, text, timestamptz, jsonb, boolean), public.zone_search_forget(text[], text),
  public.zone_search_find(text, text, text[], text, text[], integer, integer), public.zone_search_items(text[], text[]), public.zone_search_status() from public, anon, authenticated;
grant execute on function public.zone_search_replace(text, text, text, text, text, timestamptz, jsonb, boolean), public.zone_search_forget(text[], text),
  public.zone_search_find(text, text, text[], text, text[], integer, integer), public.zone_search_items(text[], text[]), public.zone_search_status() to service_role;
