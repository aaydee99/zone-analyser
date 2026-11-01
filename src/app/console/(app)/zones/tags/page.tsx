'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Download, Merge, RefreshCw, Search, Tags, Trash2, Upload } from 'lucide-react';
import { api, relTime } from '@/lib/client';
import { filterToParams, isFilterEmpty, parseTags, type ZoneMetaFilter, type ZoneMetaLite } from '@/lib/zone-meta-types';
import { Alert, Badge, Button, Card, CheckboxBox, EmptyState, Field, Loading, Modal, PageHeader, SectionHeader, SkeletonTable, cx } from '@/components/ui';
import { TagChips, TagFilter, knownTags, type OwnerCount, type TagCount } from '@/components/tag-filter';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';

// Zone tags and owners for the whole estate: every tag with its count (rename, merge, remove), bulk
// tagging of the zones a search and filter match, and CSV export / import. Console data only.

interface ZoneRow { id: string; name: string; accountName: string; status: string; plan: string }
interface SearchPage { zones: ZoneRow[]; meta: Record<string, ZoneMetaLite>; total: number; offset: number; of: number }
interface ImportResult { rows: number; matched: number; changed: number; unknown: string[]; unknownCount: number; errors: string[]; dryRun: boolean }

const PAGE = 50;
import { compactNum, whole } from '@/lib/num';
const zoneHref = (f: ZoneMetaFilter) => `/console/zone-explorer?${filterToParams(f)}`;

/** Waits until `value` has stopped changing for `ms`. */
function useSettled<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function TagList({ tags, owners, editable, onChanged, onFilter }: { tags: TagCount[]; owners: OwnerCount[]; editable: boolean; onChanged: () => void; onFilter: (f: ZoneMetaFilter) => void }) {
  const toast = useToast();
  const [find, setFind] = useState('');
  const [renaming, setRenaming] = useState<TagCount | null>(null);
  const [removing, setRemoving] = useState<TagCount | null>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => { const s = find.trim().toLowerCase(); return s ? tags.filter((t) => t.tag.includes(s)) : tags; }, [tags, find]);
  const target = parseTags([to]).tags[0];
  const merging = !!target && tags.some((t) => t.tag === target);
  const rename = async (from: string, next: string) => {
    setBusy(true);
    try {
      const r = await api<{ changed: number }>('/api/zones/tags/rename', { method: 'POST', json: { from, to: next } });
      toast(next ? `${from} → ${next} on ${compactNum(r.changed)} zone${r.changed === 1 ? '' : 's'}` : `${from} removed from ${compactNum(r.changed)} zone${r.changed === 1 ? '' : 's'}`);
      setRenaming(null); setRemoving(null);
      onChanged();
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Card>
      <SectionHeader title="Tags" description={`${whole.format(tags.length)} tag${tags.length === 1 ? '' : 's'} in use, most used first.`} aside={tags.length > 10 ? (
        <label className="relative block w-44 shrink-0 sm:w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <input className="input !py-1.5 !pl-8 !text-[13px]" placeholder="Find a tag" aria-label="Find a tag" value={find} onChange={(e) => setFind(e.target.value)} />
        </label>
      ) : undefined} />
      {!tags.length ? <EmptyState icon={<Tags className="size-5" />} title="No tags yet" description="Tag zones below, from a zone in the zone explorer, or by importing a CSV." /> : (
        <ul className="max-h-[420px] divide-y divide-line/60 overflow-y-auto">
          {shown.slice(0, 500).map((t) => (
            <li key={t.tag} className="flex flex-wrap items-center gap-3 px-5 py-2">
              <button type="button" className="font-mono text-[13px] text-ink hover:text-signal" onClick={() => onFilter({ tags: [t.tag] })} title="Show these zones below">{t.tag}</button>
              <Badge>{whole.format(t.count)}</Badge>
              <span className="ml-auto flex items-center gap-1">
                <Link href={zoneHref({ tags: [t.tag] })} className="rounded px-2 py-1 text-[12px] text-muted hover:bg-raised hover:text-ink">Zone explorer</Link>
                {editable && <>
                  <button type="button" className="rounded p-1.5 text-muted hover:bg-raised hover:text-ink" aria-label={`Rename or merge ${t.tag}`} title="Rename or merge" onClick={() => { setTo(''); setRenaming(t); }}><Merge className="size-3.5" /></button>
                  <button type="button" className="rounded p-1.5 text-muted hover:bg-raised hover:text-bad" aria-label={`Remove ${t.tag} from every zone`} title="Remove from every zone" onClick={() => setRemoving(t)}><Trash2 className="size-3.5" /></button>
                </>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {owners.length > 0 && (
        <div className="border-t border-line px-5 py-3 text-[12.5px]">
          <span className="text-muted">Owners: </span>
          {owners.slice(0, 40).map((o, i) => <span key={o.owner}>{i ? ', ' : ''}<button type="button" className="text-ink-2 hover:text-signal" onClick={() => onFilter({ owner: o.owner })}>{o.owner}</button> <span className="text-faint">{whole.format(o.count)}</span></span>)}
        </div>
      )}
      <Modal open={!!renaming} onClose={() => setRenaming(null)} title={`Rename ${renaming?.tag ?? ''}`} description={`On all ${renaming?.count ?? 0} zones that carry it. An existing tag's name merges the two.`}
        footer={<><Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!target || target === renaming?.tag} onClick={() => rename(renaming!.tag, target!)}>{merging ? 'Merge' : 'Rename'}</Button></>}>
        <Field label="New name" hint={merging ? `${target} already exists: the zones get ${target} and lose ${renaming?.tag}.` : 'Letters, digits and : . _ / -'} error={to.trim() && !target ? 'Not a tag' : undefined}>
          <input className="input font-mono" value={to} onChange={(e) => setTo(e.target.value)} list="tag-rename-list" autoFocus />
        </Field>
        <datalist id="tag-rename-list">{tags.filter((t) => t.tag !== renaming?.tag).slice(0, 300).map((t) => <option key={t.tag} value={t.tag} />)}</datalist>
      </Modal>
      <Modal open={!!removing} onClose={() => setRemoving(null)} title={`Remove ${removing?.tag ?? ''}?`} description={`It is taken off all ${removing?.count ?? 0} zones. Recorded in the audit log.`}
        footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Keep it</Button><Button variant="danger" loading={busy} onClick={() => rename(removing!.tag, '')}>Remove</Button></>}>
        <p className="text-[13px] text-muted">Owners, contacts and other tags stay as they are.</p>
      </Modal>
    </Card>
  );
}

/** Zones matching a name search and a tag filter, 50 at a time, with bulk add / remove / owner for the selection or every match. */
function BulkTagger({ filter, setFilter, editable, version, onChanged }: { filter: ZoneMetaFilter; setFilter: (f: ZoneMetaFilter) => void; editable: boolean; version: number; onChanged: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const term = useSettled(q.trim());
  const [page, setPage] = useState<SearchPage | null>(null);
  const [rows, setRows] = useState<ZoneRow[]>([]);
  const [meta, setMeta] = useState<Record<string, ZoneMetaLite>>({});
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [add, setAdd] = useState('');
  const [remove, setRemove] = useState('');
  const [owner, setOwner] = useState('');
  const [setOwnerToo, setSetOwnerToo] = useState(false);
  const [confirm, setConfirm] = useState<'picked' | 'all' | null>(null);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const params = useMemo(() => { const p = filterToParams(filter); if (term) p.set('q', term); return p; }, [filter, term]);
  const read = useCallback((offset: number) => api<SearchPage>(`/api/zones/search?${params}&offset=${offset}&limit=${PAGE}`), [params]);
  useEffect(() => {
    let live = true;
    setPage(null);
    read(0).then((p) => { if (!live) return; setPage(p); setRows(p.zones); setMeta(p.meta); setError(''); setAt(Date.now()); setPicked(new Set()); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [read, version, reload]);
  const loadMore = async () => {
    setMore(true);
    try { const p = await read(rows.length); setRows((r) => [...r, ...p.zones]); setMeta((m) => ({ ...m, ...p.meta })); } catch (e) { setError((e as Error).message); } finally { setMore(false); }
  };
  const a = parseTags(add), r = parseTags(remove);
  const ready = (a.tags.length > 0 || r.tags.length > 0 || setOwnerToo) && !a.bad.length && !r.bad.length;
  const count = confirm === 'picked' ? picked.size : page?.total ?? 0;
  const apply = async () => {
    setBusy(true);
    try {
      const sel = confirm === 'picked' ? { zoneIds: [...picked] } : { filter, search: term };
      const res = await api<{ zones: number; changed: number }>('/api/zones/meta/bulk', { method: 'POST', json: { ...sel, add: a.tags, remove: r.tags, ...(setOwnerToo ? { owner } : {}) } });
      toast(`${whole.format(res.changed)} of ${whole.format(res.zones)} zones changed`);
      setConfirm(null); setAdd(''); setRemove('');
      void knownTags(true).catch(() => {});
      onChanged();
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  const allPicked = rows.length > 0 && rows.every((z) => picked.has(z.id));
  return (
    <Card>
      <SectionHeader title="Zones" description="Search by name, filter by tag or owner, then tag the zones you pick, or every zone that matches."
        aside={<span className="flex items-center gap-2 text-[11px] text-faint">{at && <span>as of {relTime(at)}</span>}
          <button type="button" className="rounded p-1 text-muted hover:bg-raised hover:text-ink" onClick={() => setReload((n) => n + 1)} aria-label="Refresh the zones" title="Refresh"><RefreshCw className="size-3.5" /></button></span>} />
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <label className="relative block w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <input className="input !py-1.5 !pl-8 !text-[13px]" placeholder="Zone or account name" aria-label="Search zones by name" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <TagFilter value={filter} onChange={setFilter} className="min-w-0 flex-1" />
      </div>
      {editable && (
        <div className="grid gap-3 border-b border-line px-5 py-3 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
          <Field label="Add tags" error={a.bad.length ? `Not a tag: ${a.bad.join(', ')}` : undefined}><input className="input font-mono !text-[13px]" value={add} onChange={(e) => setAdd(e.target.value)} placeholder="env:prod, team:payments" /></Field>
          <Field label="Remove tags" error={r.bad.length ? `Not a tag: ${r.bad.join(', ')}` : undefined}><input className="input font-mono !text-[13px]" value={remove} onChange={(e) => setRemove(e.target.value)} placeholder="env:staging" /></Field>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-[13px] font-medium text-ink-2"><input type="checkbox" checked={setOwnerToo} onChange={(e) => setSetOwnerToo(e.target.checked)} /> Set the owner</label>
            <input className="input !text-[13px]" aria-label="Owner to set" disabled={!setOwnerToo} maxLength={200} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Blank clears it" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!ready || !picked.size} onClick={() => setConfirm('picked')}>Apply to {whole.format(picked.size)} picked</Button>
            <Button size="sm" variant="primary" disabled={!ready || !page?.total} onClick={() => setConfirm('all')}>Apply to all {page ? whole.format(page.total) : ''}</Button>
          </div>
        </div>
      )}
      {error ? <p className="px-5 py-6 text-sm text-bad">{error}</p> : !page ? <Loading label="Loading zones" className="p-5"><SkeletonTable rows={5} cols={4} /></Loading>
        : !rows.length ? <p className="px-5 py-8 text-center text-sm text-muted">No zone matches.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-muted">
                  {editable && <th className="w-10 px-4 py-2.5"><button type="button" aria-label={allPicked ? 'Unpick every zone shown' : 'Pick every zone shown'} onClick={() => setPicked(allPicked ? new Set() : new Set(rows.map((z) => z.id)))}><CheckboxBox checked={allPicked} indeterminate={!allPicked && picked.size > 0} /></button></th>}
                  {['Zone', 'Account', 'Tags and owner'].map((h) => <th key={h} className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((z) => (
                  <tr key={z.id} className={cx('border-b border-line/60 last:border-0 hover:bg-raised/40', picked.has(z.id) && 'bg-signal/[0.04]')}>
                    {editable && <td className="px-4 py-2"><input type="checkbox" aria-label={`Pick ${z.name}`} checked={picked.has(z.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(z.id); else n.delete(z.id); setPicked(n); }} /></td>}
                    <td className="px-4 py-2"><Link href={`/console/zone-explorer?zone=${encodeURIComponent(z.id)}`} className="text-ink hover:text-signal">{z.name}</Link>{z.status !== 'active' && <Badge tone="warn" className="ml-2">{z.status}</Badge>}</td>
                    <td className="px-4 py-2 text-ink-2">{z.accountName}</td>
                    <td className="px-4 py-2">{meta[z.id] ? <TagChips tags={meta[z.id].tags} owner={meta[z.id].owner} max={8} onPick={(t) => setFilter({ ...filter, tags: [...new Set([...(filter.tags ?? []), t])].sort() })} /> : <span className="text-faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[12px] text-muted">
              <span>{whole.format(page.total)} of {whole.format(page.of)} zones match{!isFilterEmpty(filter) || term ? '' : ' (all)'}</span>
              {page.total > rows.length && <Button size="sm" variant="ghost" loading={more} onClick={loadMore}>Show more ({whole.format(page.total - rows.length)} left)</Button>}
            </div>
          </div>
        )}
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={`Change ${whole.format(count)} zone${count === 1 ? '' : 's'}?`} description="Console tags only — nothing is sent to Cloudflare. Recorded in the audit log."
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={apply}>Apply</Button></>}>
        <ul className="space-y-1 text-[13px]">
          {a.tags.length > 0 && <li>Add <span className="font-mono">{a.tags.join(', ')}</span></li>}
          {r.tags.length > 0 && <li>Remove <span className="font-mono">{r.tags.join(', ')}</span></li>}
          {setOwnerToo && <li>Owner → {owner.trim() ? `“${owner.trim()}”` : 'none'}</li>}
          {confirm === 'all' && <li className="text-muted">Every zone matching {term ? `“${term}”` : 'the search'}{!isFilterEmpty(filter) ? ' and the tag filter' : ''}.</li>}
        </ul>
      </Modal>
    </Card>
  );
}

function CsvPanel({ editable, onChanged }: { editable: boolean; onChanged: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState('');
  const [name, setName] = useState('');
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState('');
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await fetch('/api/zones/meta/export', { cache: 'no-store' });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      const file = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'zone-tags.csv';
      const href = URL.createObjectURL(await res.blob());
      const el = document.createElement('a');
      el.href = href; el.download = file; el.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setExporting(false); }
  };
  const pick = async (f: File | undefined) => {
    setCheck(null);
    if (!f) return;
    if (f.size > 900_000) { toast('The file is larger than 900 KB — split it into parts', 'bad'); return; }
    const text = await f.text();
    setCsv(text); setName(f.name);
    await send(text, true);
  };
  const send = async (text: string, dryRun: boolean) => {
    setBusy(dryRun ? 'check' : 'import');
    try {
      const r = await api<ImportResult>('/api/zones/meta/import', { method: 'POST', json: { csv: text, dryRun } });
      setCheck(r);
      if (!dryRun) { toast(`${whole.format(r.changed)} zone${r.changed === 1 ? '' : 's'} changed`); void knownTags(true).catch(() => {}); onChanged(); }
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(''); }
  };
  return (
    <Card>
      <SectionHeader title="CSV" description="Export every zone with its tags and owner, fill it in, and import it again. Columns: zone_id (or zone_name), tags (separated by ;), owner, contact, notes — only the columns in the file change." />
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap gap-2">
          <Button icon={<Download className="size-4" />} loading={exporting} onClick={exportCsv}>Export CSV</Button>
          {editable && <>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file to import" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
            <Button icon={<Upload className="size-4" />} loading={busy === 'check'} onClick={() => fileRef.current?.click()}>Import CSV…</Button>
          </>}
        </div>
        {check && (
          <Alert tone={check.errors.length || check.unknownCount ? 'warn' : 'ok'} title={check.dryRun ? `${name}: ${whole.format(check.changed)} zone${check.changed === 1 ? '' : 's'} would change` : `Imported: ${whole.format(check.changed)} zone${check.changed === 1 ? '' : 's'} changed`}>
            <p>{whole.format(check.rows)} rows · {whole.format(check.matched)} zones found{check.unknownCount ? ` · ${whole.format(check.unknownCount)} not found (skipped): ${check.unknown.slice(0, 5).join(', ')}${check.unknownCount > 5 ? '…' : ''}` : ''}</p>
            {check.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs">{check.errors.slice(0, 8).map((e) => <li key={e}>{e}</li>)}</ul>}
            {check.dryRun && check.changed > 0 && <div className="mt-3"><Button variant="primary" size="sm" loading={busy === 'import'} onClick={() => send(csv, false)}>Import {whole.format(check.changed)} change{check.changed === 1 ? '' : 's'}</Button></div>}
          </Alert>
        )}
      </div>
    </Card>
  );
}

export default function ZoneTagsPage() {
  const { can } = useMe();
  const editable = can('zones:tag');
  const [data, setData] = useState<{ tags: TagCount[]; owners: OwnerCount[] } | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<ZoneMetaFilter>({});
  const [version, setVersion] = useState(0);
  const load = useCallback((fresh: boolean) => knownTags(fresh).then((d) => { setData(d); setError(''); }).catch((e) => setError((e as Error).message)), []);
  useEffect(() => { void load(false); }, [load]);
  const changed = () => { void load(true); setVersion((n) => n + 1); };
  return (
    <div className="rise space-y-5">
      <PageHeader eyebrow="Zones" title="Zone tags"
        description={`Tags, owners and contacts for every zone, kept in the console (never sent to Cloudflare). Filter the zone explorer and monitoring by them.${editable ? ' Every change is in the audit log.' : ' Read-only: changing tags needs the zones:tag permission.'}`} />
      {error && <Alert tone="bad" title="Tags could not be read">{error}</Alert>}
      <div className="grid items-start gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="space-y-5">
          {!data && !error ? <Card><Loading label="Loading tags" className="p-5"><SkeletonTable rows={6} cols={2} /></Loading></Card>
            : data && <TagList tags={data.tags} owners={data.owners} editable={editable} onChanged={changed} onFilter={setFilter} />}
          <CsvPanel editable={editable} onChanged={changed} />
        </div>
        <BulkTagger filter={filter} setFilter={setFilter} editable={editable} version={version} onChanged={changed} />
      </div>
    </div>
  );
}
