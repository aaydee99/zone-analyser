'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Database, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { INDEX_KINDS, type IndexKind } from '@/lib/zone-index';
import type { IndexStatus, SearchHit, SearchResult } from '@/lib/zone-search';
import { Alert, Badge, Button, Card, EmptyState, Field, Loading, PageHeader, SectionHeader, SkeletonTable, cx } from '@/components/ui';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';

import { whole } from '@/lib/num';
const PAGE = 50;
const KIND_LABEL = Object.fromEntries(INDEX_KINDS.map((k) => [k.kind, k.label])) as Record<IndexKind, string>;

type Answer = SearchResult & { generatedAt: string };

/** "from backup 2d ago", "from drift snapshot 3h ago". */
const age = (h: Pick<SearchHit, 'source' | 'sourceAt'>) => `${h.source === 'backup' ? 'backup' : h.source === 'drift' ? 'drift snapshot' : `monitoring (${h.source.replace(/^monitor:/, '')})`} ${relTime(h.sourceAt)}`;

function SearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { can } = useMe();
  const q = params.get('q') ?? '';
  const mode = params.get('mode') === 'exact' ? 'exact' : 'contains';
  const kind = params.get('kind') ?? '';
  const account = params.get('account') ?? '';
  const tag = params.get('tag') ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);

  // The form keeps what is typed; the URL holds what was searched (so a search can be shared).
  const [form, setForm] = useState({ q, mode, kind, account, tag });
  useEffect(() => { setForm({ q, mode, kind, account, tag }); }, [q, mode, kind, account, tag]);

  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [rebuilding, setRebuilding] = useState(false);

  const query = useCallback(() => {
    const u = new URLSearchParams({ q, mode, offset: String(offset), limit: String(PAGE) });
    if (kind) u.set('kind', kind);
    if (account) u.set('account', account);
    if (tag) u.set('tag', tag);
    return u.toString();
  }, [q, mode, kind, account, tag, offset]);

  const load = useCallback(async () => {
    if (!q) { setData(null); return; }
    setLoading(true);
    try { setData(await api<Answer>(`/api/search?${query()}`)); setError(''); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [q, query]);
  const loadStatus = useCallback(async () => {
    try { setStatus(await api<IndexStatus>('/api/search/index')); setStatusError(''); } catch (e) { setStatusError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const go = (next: Partial<typeof form> & { offset?: number }) => {
    const f = { ...form, ...next };
    const u = new URLSearchParams();
    if (f.q.trim()) u.set('q', f.q.trim());
    if (f.mode === 'exact') u.set('mode', 'exact');
    if (f.kind) u.set('kind', f.kind);
    if (f.account.trim()) u.set('account', f.account.trim());
    if (f.tag.trim()) u.set('tag', f.tag.trim());
    if (next.offset) u.set('offset', String(next.offset));
    router.replace(`/console/search${u.size ? `?${u}` : ''}`);
  };

  const rebuild = async () => {
    setRebuilding(true);
    try {
      const r = await api<{ started: boolean; status: IndexStatus }>('/api/search/index', { method: 'POST' });
      setStatus(r.status);
      toast(r.started ? 'Rebuilding the index in the background — press Refresh to see how far it got' : 'A rebuild is already running', 'info');
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setRebuilding(false); }
  };

  const refresh = () => { void load(); void loadStatus(); };
  const rb = status?.rebuild;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Search" title="Where is this used?"
        description="Search every zone's stored configuration — DNS records, settings, rule expressions, headers, redirects, Page Rules, Worker routes, certificates — for an IP or range, a hostname, a header or any text. From backups, drift snapshots and monitoring results; Cloudflare is not asked."
        actions={<>
          <Button variant="ghost" loading={loading || (!status && !statusError)} onClick={refresh} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {can('monitors:manage') && <Button loading={rebuilding} disabled={!!rb && !rb.finishedAt} onClick={rebuild} icon={<RotateCcw className="size-4" />}>Rebuild index</Button>}
        </>} />

      <Card>
        <form className="grid gap-4 p-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]" onSubmit={(e) => { e.preventDefault(); go({}); }}>
          <Field label="Search for" hint="An IP or range (192.0.2.0/24), a hostname, a header name, part of an expression …">
            <input className="input" type="search" value={form.q} maxLength={200} autoFocus placeholder="203.0.113.10" onChange={(e) => setForm({ ...form, q: e.target.value })} />
          </Field>
          <Field label="Match">
            <select className="input" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value === 'exact' ? 'exact' : 'contains' })}>
              <option value="contains">Contains</option>
              <option value="exact">Whole value</option>
            </select>
          </Field>
          <Field label="Kind">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="">Everything</option>
              {INDEX_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="Account ID" optional>
            <input className="input font-mono" value={form.account} maxLength={64} placeholder="All accounts" onChange={(e) => setForm({ ...form, account: e.target.value })} />
          </Field>
          <Field label="Zone tags" optional hint="Comma-separated; zones with all of them">
            <input className="input" value={form.tag} maxLength={300} placeholder="All zones" onChange={(e) => setForm({ ...form, tag: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" className="w-full" icon={<Search className="size-4" />} disabled={!form.q.trim()}>Search</Button>
          </div>
        </form>
      </Card>

      {error && <Alert tone="bad" title="The search failed">{error}</Alert>}
      {!q ? (
        <Card><EmptyState icon={<Search className="size-5" />} title="Search every zone" description="Type what you are looking for above. Results show the zone, where in it the value is, and how old the stored data is." /></Card>
      ) : !data ? (
        <Loading label="Searching"><SkeletonTable rows={8} cols={4} /></Loading>
      ) : (
        <Results data={data} onPage={(o) => go({ offset: o })} />
      )}

      <IndexCard status={status} error={statusError} />
    </div>
  );
}

function Snippet({ s }: { s: SearchHit['snippet'] }) {
  return (
    <span className="font-mono text-[12px] break-all text-ink-2">
      {s.before}{s.match && <mark className="rounded bg-signal/20 px-0.5 text-ink">{s.match}</mark>}{s.after}
    </span>
  );
}

function Results({ data, onPage }: { data: Answer; onPage: (offset: number) => void }) {
  const end = data.offset + data.hits.length;
  return (
    <Card>
      <SectionHeader title={data.total ? `${data.capped ? 'More than ' : ''}${whole.format(data.total)} match${data.total === 1 ? '' : 'es'}` : 'No matches'}
        description={data.note ?? (data.capped ? 'Only the first 5,000 are shown: narrow the search with a kind, an account or tags.' : undefined)}
        aside={<span className="text-[12px] text-faint" title={fmtDate(data.generatedAt)}>As of {new Date(data.generatedAt).toLocaleTimeString()}</span>} />
      {!data.hits.length ? (
        <p className="px-5 py-8 text-center text-sm text-muted">Nothing in the stored configuration matches “{data.q}”. {data.mode === 'exact' ? 'Try “Contains”.' : ''}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-muted">
                {['Zone', 'Where', 'Value', 'From'].map((h) => <th key={h} scope="col" className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.hits.map((h, i) => (
                <tr key={`${h.zoneId}-${i}`} className="border-b border-line/60 align-top last:border-0 hover:bg-raised/40">
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <Link href={`/console/compare/zones?a=${encodeURIComponent(h.zoneId)}`} className="font-medium text-ink hover:text-signal" title="Compare this zone">{h.zoneName}</Link>
                  </td>
                  <td className="max-w-[340px] px-4 py-2.5">
                    <Badge className="mr-1.5">{KIND_LABEL[h.kind] ?? h.kind}</Badge>
                    <span className="break-words text-ink-2">{h.where}</span>
                  </td>
                  <td className="max-w-[420px] px-4 py-2.5"><Snippet s={h.snippet} /></td>
                  <td className="px-4 py-2.5 text-[12px] whitespace-nowrap text-muted" title={`${h.sourceLabel} · ${fmtDate(h.sourceAt)}`}>{age(h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-[12px] text-muted">
            <span>{whole.format(data.offset + 1)}–{whole.format(end)} of {data.capped ? 'more than ' : ''}{whole.format(data.total)}</span>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={!data.offset} onClick={() => onPage(Math.max(0, data.offset - data.limit))}>Previous</Button>
              <Button size="sm" variant="ghost" disabled={end >= data.total} onClick={() => onPage(end)}>Next</Button>
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function IndexCard({ status, error }: { status: IndexStatus | null; error: string }) {
  const rb = status?.rebuild;
  return (
    <Card>
      <SectionHeader title="What is searched" description="Filled as backups finish and monitoring reads zones; Rebuild index reads everything stored again (only zones whose newest backup is not indexed yet are read from the buckets)." />
      {error ? <p className="px-5 py-5 text-sm text-bad">{error}</p> : !status ? <div className="p-5"><SkeletonTable rows={3} cols={4} /></div> : (
        <div className="space-y-3 px-5 py-4 text-[13px]">
          {!status.sources.length ? (
            <div className="flex items-center gap-3 text-muted"><Database className="size-4" /> Nothing is indexed yet. It fills as backups finish and monitoring runs{rb ? '' : ', or with Rebuild index'}.</div>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {status.sources.map((s) => (
                <li key={s.source} className="rounded-lg border border-line px-3 py-2">
                  <div className="font-medium text-ink">{s.label.replace(/^./, (c) => c.toUpperCase())}</div>
                  <div className="text-[12px] text-muted">{whole.format(s.zones)} zones · {whole.format(s.rows)} values{s.newest ? ` · newest ${relTime(s.newest)}` : ''}</div>
                </li>
              ))}
            </ul>
          )}
          {rb && (
            <p className={cx('text-[12px]', rb.error ? 'text-bad' : 'text-muted')}>
              Rebuild by {rb.by}, started {relTime(rb.startedAt)}: {rb.finishedAt ? (rb.error ? `failed — ${rb.error}` : `done ${relTime(rb.finishedAt)}`) : `${rb.step.toLowerCase()} (${whole.format(rb.done)} read)`} · {whole.format(rb.indexed.backup)} backups, {whole.format(rb.indexed.drift)} snapshots, {whole.format(rb.indexed.monitor)} monitoring results indexed
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Page() {
  return <Suspense><SearchPage /></Suspense>;
}
