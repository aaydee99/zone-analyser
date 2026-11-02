'use client';

import { compactNum } from '@/lib/num';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Globe, RefreshCw, Search } from 'lucide-react';
import { api } from '@/lib/client';
import type { ZoneListItem } from '@/lib/zone-catalog';
import { Alert, Badge, Button, Card, EmptyState, Loading, PageHeader, Skeleton, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useZoneStore } from '@/lib/stores/zone-store';
import { useUiState } from '@/lib/stores/ui-state';
import { filterToParams, isFilterEmpty, parseTags, type ZoneMetaFilter, type ZoneMetaLite } from '@/lib/zone-meta-types';
import { TagChips, TagFilter } from '@/components/tag-filter';
import { SavedViews } from '@/components/saved-views';
import { ZoneView } from './zone-view';

const NO_FILTER: ZoneMetaFilter = {};

export default function ZoneExplorerPage() {
  const toast = useToast();
  // The zone list and the open zone live in the zone store: shared with every page and the zone
  // panel, and kept while you visit other pages (coming back shows the same zone at once).
  const listData = useZoneStore((s) => s.list);
  const listing = useZoneStore((s) => s.listing);
  const listError = useZoneStore((s) => s.listError);
  const loadList = useZoneStore((s) => s.loadList);
  const selected = useZoneStore((s) => s.selected);
  const select = useZoneStore((s) => s.select);
  const openZone = useZoneStore((s) => s.openZone);
  const loading = useZoneStore((s) => !!s.selected && !!s.zones[s.selected]?.loading);
  const zones = useMemo(() => listData?.zones ?? (listError ? [] : null), [listData, listError]);
  const problems = listData?.problems ?? [];
  // The find box and the tag filter are kept while you visit other pages (ui-state store).
  const [q, setQ] = useUiState('zx.q', '');
  // Console tags and owners: the filter is resolved by the server (?tags=&owner=), the chips come with it.
  const [zf, setZf] = useUiState<ZoneMetaFilter>('zx.filter', NO_FILTER);
  const [meta, setMeta] = useState<Record<string, ZoneMetaLite>>({});
  const [matching, setMatching] = useState<Set<string> | null>(null);
  const [metaError, setMetaError] = useState('');

  const list = useCallback(async (fresh = false) => {
    try { await loadList(fresh); } catch (e) { toast((e as Error).message, 'bad'); }
  }, [loadList, toast]);
  useEffect(() => { void list(); }, [list]);

  /** Tags and owners of every zone, and the zones the tag filter matches (no zone list: the page has it). */
  const filterKey = filterToParams(zf).toString();
  const [metaVersion, setMetaVersion] = useState(0);
  useEffect(() => {
    let live = true;
    const p = new URLSearchParams(filterKey);
    p.set('meta', '1'); p.set('list', '0');
    api<{ ids: string[] | null; meta?: Record<string, ZoneMetaLite>; metaError?: string }>(`/api/zone-explorer?${p}`)
      .then((r) => { if (!live) return; setMeta(r.meta ?? {}); setMatching(r.ids ? new Set(r.ids) : null); setMetaError(r.metaError ?? ''); })
      .catch((e) => { if (live) { setMatching(null); setMetaError((e as Error).message); } });
    return () => { live = false; };
  }, [filterKey, metaVersion]);

  /** Opens a zone (from the store when it was read already). One at a time: the list waits while it loads. */
  const open = useCallback((id: string) => {
    if (useZoneStore.getState().zones[useZoneStore.getState().selected]?.loading) return;
    select(id);
    void openZone(id);
  }, [select, openZone]);

  const shownZones = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (zones ?? []).filter((z) => (!matching || matching.has(z.id)) && (!s || [z.name, z.accountName, z.id, z.plan, z.status].some((x) => x.toLowerCase().includes(s))));
  }, [zones, q, matching]);
  const filtering = !!q.trim() || !isFilterEmpty(zf);

  // The address keeps the filters and the open zone (?q=&tags=&owner=&zone=): shareable, and what a saved view holds.
  const viewQuery = useMemo(() => { const p = filterToParams(zf); if (q.trim()) p.set('q', q.trim()); p.sort(); return p.toString(); }, [zf, q]);
  const applyQuery = useCallback((qs: string) => {
    const p = new URLSearchParams(qs);
    setQ(p.get('q') ?? '');
    setZf({ tags: parseTags(p.get('tags') ?? '').tags, owner: p.get('owner') ?? '', q: p.get('mq') ?? '' });
  }, [setQ, setZf]);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const p = new URLSearchParams(window.location.search);
    // A link or saved view sets the filters; a plain visit keeps the ones you had.
    if (['q', 'tags', 'owner', 'mq'].some((k) => p.has(k))) applyQuery(p.toString());
    const z = p.get('zone');
    // ?zone= opens that zone; without it, the zone open when you left the page stays open.
    if (z && /^[A-Za-z0-9_-]{1,64}$/.test(z)) open(z);
  }, [applyQuery, open]);
  useEffect(() => {
    if (!started.current) return;
    const p = new URLSearchParams(viewQuery);
    if (selected) p.set('zone', selected);
    const next = `${window.location.pathname}${p.size ? `?${p}` : ''}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, '', next);
  }, [viewQuery, selected]);

  const pickTag = (t: string) => setZf((cur) => ({ ...cur, tags: [...new Set([...(cur.tags ?? []), t])].sort() }));
  const byAccount = useMemo(() => {
    const m = new Map<string, { id: string; name: string; zones: ZoneListItem[] }>();
    for (const z of shownZones) {
      const id = z.accountId || z.accountName || 'unknown';
      const g = m.get(id) ?? { id, name: z.accountName || z.accountId || 'Unknown account', zones: [] };
      g.zones.push(z);
      m.set(id, g);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [shownZones]);

  // Accounts as accordions: open when there is only one, for the open zone's account, and while
  // searching. What you open or close is remembered in this browser.
  const [openAccounts, setOpenAccounts] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { setOpenAccounts(JSON.parse(localStorage.getItem('zx.openAccounts') ?? '{}') as Record<string, boolean>); } catch { /* storage blocked */ }
  }, []);
  const setAccountsOpen = (next: Record<string, boolean>) => {
    setOpenAccounts(next);
    try { localStorage.setItem('zx.openAccounts', JSON.stringify(next)); } catch { /* storage blocked */ }
  };
  const isOpen = (g: { id: string; zones: ZoneListItem[] }) =>
    filtering || (openAccounts[g.id] ?? (byAccount.length === 1 || g.zones.some((z) => z.id === selected)));
  const allOpen = byAccount.every(isOpen);


  return (
    <div className="rise">
      <PageHeader eyebrow="Cloudflare" title="Zone explorer"
        description="Everything the stored Cloudflare tokens can read about any zone: settings, DNS, SSL/TLS, security, rules, caching and more. Read-only — only GET requests are sent."
        actions={<Button icon={<RefreshCw className={cx('size-4', listing && 'animate-spin')} />} onClick={() => list(true)} disabled={listing}>Refresh zones</Button>} />

      {problems.map((p) => <div key={p.credential} className="mb-4"><Alert tone="warn" title={p.credential}>{p.error}</Alert></div>)}

      {zones && !zones.length ? (
        <Card><EmptyState icon={<Globe className="size-5" />} title="No zones" description="No stored Cloudflare token can list zones. A super admin adds tokens (with Zone: Read) under Credentials." /></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <Card className="self-start lg:sticky lg:top-4">
            <label className="relative block border-b border-line p-3">
              <span className="sr-only">Find a zone</span>
              <Search className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-1/2 text-faint" aria-hidden />
              <input className="input !pl-9" placeholder={zones ? `Find among ${compactNum(zones.length)} zones…` : 'Loading zones…'} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <div className="space-y-2 border-b border-line px-3 py-2.5">
              <TagFilter value={zf} onChange={setZf} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SavedViews path="/console/zone-explorer" query={viewQuery} onApply={applyQuery} />
                {matching && zones && <span className="text-[11px] text-muted">{compactNum(shownZones.length)} of {compactNum(zones.length)} zones</span>}
              </div>
              {metaError && <p className="text-[11px] text-warn">{metaError}</p>}
            </div>
            <div className="max-h-[60vh] overflow-y-auto lg:max-h-[calc(100vh-12rem)]">
              {byAccount.length > 1 && !filtering && (
                <div className="flex items-center justify-between border-b border-line/60 px-4 py-2 text-[11px] text-muted">
                  <span>{compactNum(byAccount.length)} accounts</span>
                  <button type="button" className="hover:text-ink" onClick={() => setAccountsOpen(Object.fromEntries(byAccount.map((g) => [g.id, !allOpen])))}>
                    {allOpen ? 'Collapse all' : 'Expand all'}
                  </button>
                </div>
              )}
              {byAccount.map((g) => {
                const expanded = isOpen(g);
                const inactive = g.zones.filter((z) => z.status !== 'active').length;
                return (
                  <section key={g.id} className="border-b border-line/60 last:border-0">
                    <button type="button" aria-expanded={expanded} aria-controls={`zx-acct-${g.id}`}
                      onClick={() => setAccountsOpen({ ...openAccounts, [g.id]: !expanded })}
                      className="sticky top-0 z-10 flex w-full items-center gap-2 bg-surface/95 px-3 py-2.5 text-left backdrop-blur hover:bg-raised/60">
                      <ChevronRight className={cx('size-4 shrink-0 text-faint transition-transform', expanded && 'rotate-90')} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">{g.name}</span>
                        {g.name !== g.id && /^[0-9a-f]{32}$/.test(g.id) && <span className="block truncate font-mono text-[10.5px] text-faint">{g.id}</span>}
                      </span>
                      {inactive > 0 && <Badge tone="warn">{inactive} not active</Badge>}
                      <Badge>{compactNum(g.zones.length)}</Badge>
                    </button>
                    {expanded && (
                      <div id={`zx-acct-${g.id}`} className="pb-1">
                        {g.zones.map((z) => (
                          <button key={z.id} type="button" onClick={() => open(z.id)} aria-pressed={selected === z.id} disabled={loading}
                            title={loading ? 'Wait for the open zone to finish loading' : undefined}
                            className={cx('flex w-full items-center gap-2 py-2 pr-4 pl-9 text-left text-[13px] transition-colors enabled:hover:bg-raised/60 disabled:cursor-not-allowed', selected === z.id ? 'bg-raised text-ink' : loading && 'opacity-50')}>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{z.name}</span>
                              {meta[z.id] && <TagChips tags={meta[z.id].tags} owner={meta[z.id].owner} max={3} className="mt-0.5" />}
                            </span>
                            {z.status !== 'active' && <Badge tone="warn">{z.status}</Badge>}
                            <span className="shrink-0 text-[11px] text-faint">{z.plan.replace(/ Website$/, '')}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              {!zones && (
                <Loading label="Loading zones">
                  {[0, 1].map((i) => (
                    <div key={i} className="border-b border-line/60 pb-1 last:border-0">
                      <div className="flex items-center gap-2 px-3 py-2.5"><Skeleton className="size-4 shrink-0" /><Skeleton className="h-3.5 flex-1" /><Skeleton className="h-5 w-7" /></div>
                      {[70, 55, 82, 60].map((w) => (
                        <div key={w} className="flex items-center gap-2 py-2 pr-4 pl-9"><Skeleton className="h-3" style={{ width: `${w}%` }} /><Skeleton className="ml-auto h-3 w-8 shrink-0" /></div>
                      ))}
                    </div>
                  ))}
                </Loading>
              )}
              {zones && !shownZones.length && <p className="px-4 py-3 text-[13px] text-muted">No zone matches.</p>}
            </div>
          </Card>

          <div className="min-w-0">
            {!selected && <Card><EmptyState icon={<Globe className="size-5" />} title="Choose a zone" description="Its full configuration is read from Cloudflare when you open it." /></Card>}
            {selected && <ZoneView zoneId={selected} onPickTag={pickTag} onMetaSaved={() => setMetaVersion((n) => n + 1)} />}
          </div>
        </div>
      )}
    </div>
  );
}
