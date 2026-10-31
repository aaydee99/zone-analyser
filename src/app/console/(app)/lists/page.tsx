'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ListFilter, RefreshCw, Search } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { LIST_KINDS, LIST_KIND_LABEL, type ListItemsPage, type ListRow, type ListsView, type RefsView } from '@/lib/lists-types';
import { Alert, Badge, Button, Card, EmptyState, Loading, Modal, PageHeader, SkeletonTable, cx } from '@/components/ui';
import { when } from '@/components/monitor-view';
import { useSnapshot } from '../monitoring/use-run';

const whole = new Intl.NumberFormat();
const PAGE = 50;
const kindLabel = (k: string) => LIST_KIND_LABEL[k as keyof typeof LIST_KIND_LABEL] ?? k;

function useSettled<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** A list's items (read from Cloudflare now) and the rules that use it (as monitoring stored them). */
function ListDialog({ list, onClose }: { list: ListRow; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const term = useSettled(search.trim(), 500);
  const [items, setItems] = useState<ListItemsPage | null>(null);
  const [extra, setExtra] = useState<ListItemsPage['items']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refs, setRefs] = useState<RefsView | null>(null);
  const base = `/api/lists/items?account=${list.accountId}&list=${list.listId}${term ? `&search=${encodeURIComponent(term)}` : ''}`;
  useEffect(() => {
    let live = true;
    api<ListItemsPage>(base).then((p) => { if (live) { setItems(p); setExtra([]); setCursor(p.cursor); setError(''); } }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [base]);
  useEffect(() => {
    let live = true;
    api<RefsView>(`/api/lists/refs?account=${list.accountId}&list=${encodeURIComponent(list.name)}&limit=${PAGE}`).then((r) => { if (live) setRefs(r); }).catch(() => { if (live) setRefs({ rows: [], total: 0, offset: 0 }); });
    return () => { live = false; };
  }, [list.accountId, list.name]);
  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try { const p = await api<ListItemsPage>(`${base}&cursor=${encodeURIComponent(cursor)}`); setExtra((x) => [...x, ...p.items]); setCursor(p.cursor); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const all = items ? [...items.items, ...extra] : [];
  return (
    <Modal open onClose={onClose} title={list.name} description={`${kindLabel(list.kind)} list in ${list.account} · ${whole.format(list.items)} items`} width="max-w-3xl">
      <div className="space-y-5">
        <section aria-labelledby="items-title">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 id="items-title" className="text-[14px] font-semibold">Items</h3>
            <label className="relative block w-60">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
              <input className="input !py-1.5 !pl-8 !text-[13px]" placeholder={list.kind === 'ip' ? 'IP starts with…' : list.kind === 'asn' ? 'ASN (exact)' : 'Contains…'} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search the items" />
            </label>
          </div>
          {error ? <Alert tone="bad">{error}</Alert> : !items ? <SkeletonTable rows={5} cols={3} /> : all.length === 0 ? <p className="py-4 text-center text-sm text-muted">{term ? 'Nothing matches.' : 'This list is empty.'}</p> : (
            <div className="max-h-[320px] overflow-y-auto rounded-lg border border-line">
              <table className="w-full text-left text-[13px]">
                <thead><tr className="border-b border-line text-muted">{['Item', 'Comment', 'Changed'].map((h) => <th key={h} className="px-3 py-2 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}</tr></thead>
                <tbody>{all.map((i) => (
                  <tr key={i.id} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-1.5 font-mono text-[12px] break-all text-ink-2">{i.value}</td>
                    <td className="px-3 py-1.5 text-muted">{i.comment || '—'}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted" title={i.modified ? fmtDate(i.modified) : undefined}>{i.modified ? when(i.modified) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between text-[12px] text-faint">
            <span>{items && <>Read from Cloudflare {new Date(items.generatedAt).toLocaleTimeString()}</>}</span>
            {cursor && <Button size="sm" variant="ghost" loading={busy} onClick={more}>Show more</Button>}
          </div>
        </section>
        <section aria-labelledby="refs-title">
          <h3 id="refs-title" className="mb-2 text-[14px] font-semibold">Rules that use it {refs && <span className="font-mono text-[11px] text-faint">{refs.total}</span>}</h3>
          {!refs ? <SkeletonTable rows={2} cols={4} /> : refs.rows.length === 0 ? <p className="text-sm text-muted">{list.referencedBy === 'zones not read yet' ? 'Not every zone of this account has been read yet.' : 'No rule uses this list.'}</p> : (
            <ul className="divide-y divide-line/60 rounded-lg border border-line text-[13px]">
              {refs.rows.map((r, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
                  <span className="font-medium text-ink">{r.where}</span>
                  <span className="text-ink-2">{r.rule || '(no description)'}</span>
                  <span className="font-mono text-[11.5px] text-faint">{r.phase}</span>
                  {r.action && <Badge>{r.action}</Badge>}
                  {!r.enabled && <Badge tone="warn">off</Badge>}
                </li>
              ))}
              {refs.total > refs.rows.length && <li className="px-3 py-2 text-faint">…and {whole.format(refs.total - refs.rows.length)} more (search for “{list.name}” on Monitoring › IP & ASN lists).</li>}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

export default function ListsPage() {
  const [account, setAccount] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const term = useSettled(q.trim());
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (account) params.set('account', account);
  if (kind) params.set('kind', kind);
  if (term) params.set('q', term);
  const { data, error, loading, reload, version } = useSnapshot<ListsView>(`/api/lists?${params}`);
  const [extra, setExtra] = useState<{ v: number; rows: ListRow[] }>({ v: -1, rows: [] });
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<ListRow | null>(null);
  const accounts = data?.accounts ?? [];
  const added = extra.v === version ? extra.rows : [];
  const rows = data ? [...data.rows, ...added] : [];
  const loadMore = async () => {
    setMore(true);
    try { const p = new URLSearchParams(params); p.set('offset', String(rows.length)); const page = await api<ListsView>(`/api/lists?${p}`); setExtra({ v: version, rows: [...added, ...page.rows] }); } finally { setMore(false); }
  };
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Security" title="IP & ASN lists" description="Every IP, ASN, hostname and redirect list in the accounts the tokens read, and the rules that use each one. Read once a day by monitoring; a list’s items are read from Cloudflare when you open it."
        actions={<Button variant="ghost" loading={loading} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>} />
      {data && <p className="-mt-4 text-[12.5px] text-muted">{data.lastRun ? <>lists read {when(data.lastRun)} · </> : null}as of {new Date(data.generatedAt).toLocaleTimeString()} · <Link className="text-signal hover:underline" href="/console/monitoring/lists">monitoring</Link></p>}
      {error && <Alert tone="bad" title="The lists could not be read">{error}</Alert>}
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
          <label className="grid gap-1 text-[12px] text-muted">Account
            <select className="input !py-1.5 !text-[13px]" value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">All accounts</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-[12px] text-muted">Kind
            <select className="input !py-1.5 !text-[13px]" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              {LIST_KINDS.map((k) => <option key={k} value={k}>{LIST_KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-[12px] text-muted">Search
            <span className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
              <input className="input !w-56 !py-1.5 !pl-8 !text-[13px]" placeholder="Name, description, zone" value={q} onChange={(e) => setQ(e.target.value)} />
            </span>
          </label>
          {data && <span className="ml-auto self-center font-mono text-[11px] text-faint">{whole.format(data.total)} lists</span>}
        </div>
        {!data ? <Loading label="Loading lists" className="p-5"><SkeletonTable rows={8} cols={6} /></Loading> : rows.length === 0 ? (
          <EmptyState icon={<ListFilter className="size-5" />} title={account || kind || term ? 'No list matches' : 'No lists yet'} description={account || kind || term ? 'Try another account, kind or search.' : 'Lists appear once monitoring has read each account (IP & ASN lists check). An admin can run it now from Monitoring.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13px]">
              <thead><tr className="border-b border-line text-muted">{['List', 'Account', 'Kind', 'Items', 'Rules', 'Used in', 'Changed'].map((h) => <th key={h} className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.accountId}:${r.listId}`} className="border-b border-line/60 align-top last:border-0 hover:bg-raised/40">
                    <td className="px-4 py-2.5">
                      <button type="button" className="font-mono text-[12.5px] text-signal hover:underline" onClick={() => setOpen(r)}>{r.name}</button>
                      {r.description && <div className="mt-0.5 text-[12px] text-muted">{r.description}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-ink-2">{r.account}</td>
                    <td className="px-4 py-2.5"><Badge>{kindLabel(r.kind)}</Badge></td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-ink-2">{whole.format(r.items)}</td>
                    <td className={cx('px-4 py-2.5 font-mono text-xs tabular-nums', r.refs ? 'text-ink-2' : 'text-warn')}>{whole.format(r.refs)}</td>
                    <td className="max-w-[300px] px-4 py-2.5 text-[12.5px] text-muted">{r.referencedBy || '—'}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted" title={r.modified ? fmtDate(r.modified) : undefined}>{r.modified ? when(r.modified) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.total > rows.length && (
              <div className="border-t border-line px-4 py-2.5 text-center"><Button size="sm" variant="ghost" loading={more} onClick={loadMore}>Show more ({whole.format(data.total - rows.length)} left)</Button></div>
            )}
          </div>
        )}
      </Card>
      {open && <ListDialog list={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
