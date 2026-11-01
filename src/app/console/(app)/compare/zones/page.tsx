'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeftRight, RefreshCw } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { INDEX_KINDS, type IndexKind } from '@/lib/zone-index';
import type { ZoneDiffPage } from '@/lib/compare';
import { Alert, Badge, Button, Card, EmptyState, Field, Loading, PageHeader, SectionHeader, SkeletonTable } from '@/components/ui';
import { Pager, Values, ZonePicker } from '../parts';

import { whole } from '@/lib/num';
const PAGE = 50;
const KIND_LABEL = Object.fromEntries(INDEX_KINDS.map((k) => [k.kind, k.label])) as Record<IndexKind, string>;
type Answer = ZoneDiffPage & { generatedAt: string };
type Pick = { id: string; name: string } | null;

function ZonesCompare() {
  const params = useSearchParams();
  const router = useRouter();
  const a = params.get('a') ?? '', b = params.get('b') ?? '';
  const [za, setA] = useState<Pick>(a ? { id: a, name: a } : null);
  const [zb, setB] = useState<Pick>(b ? { id: b, name: b } : null);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!a || !b) { setData(null); return; }
    setLoading(true);
    const u = new URLSearchParams({ a, b, offset: String(offset), limit: String(PAGE) });
    if (kind) u.set('kind', kind);
    if (status) u.set('status', status);
    try {
      const r = await api<Answer>(`/api/compare/zone-diff?${u}`);
      setData(r); setError('');
      // The names the server knows (a link may carry only ids).
      setA((x) => (x?.id === r.a.id ? { id: r.a.id, name: r.a.name } : x));
      setB((x) => (x?.id === r.b.id ? { id: r.b.id, name: r.b.name } : x));
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [a, b, kind, status, offset]);
  useEffect(() => { void load(); }, [load]);

  const compare = () => {
    if (!za || !zb) return;
    setOffset(0);
    router.replace(`/console/compare/zones?a=${encodeURIComponent(za.id)}&b=${encodeURIComponent(zb.id)}`);
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Compare" title="Zone vs zone"
        description="Two zones' stored configuration side by side (their newest backups and drift snapshots), with each zone's own name written as {zone} so names that naturally differ do not count. Read-only."
        actions={a && b ? <Button variant="ghost" loading={loading} onClick={load} icon={<RefreshCw className="size-4" />}>Refresh</Button> : undefined} />
      <Card>
        <div className="grid gap-4 p-5 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <ZonePicker label="Zone A" value={za} onChange={setA} />
          <ZonePicker label="Zone B" value={zb} onChange={setB} />
          <Button variant="primary" disabled={!za || !zb || za.id === zb.id} onClick={compare} icon={<ArrowLeftRight className="size-4" />}>Compare</Button>
        </div>
      </Card>
      {error && <Alert tone="bad" title="The comparison failed">{error}</Alert>}
      {!a || !b ? (
        <Card><EmptyState icon={<ArrowLeftRight className="size-5" />} title="Choose two zones" description="Settings, DNS records, rules, redirects, headers and the rest are compared item by item." /></Card>
      ) : !data ? <Loading label="Comparing"><SkeletonTable rows={8} cols={4} /></Loading> : (
        <Card>
          <SectionHeader title={`${whole.format(data.counts.different)} different · ${whole.format(data.counts.onlyA)} only in ${data.a.name} · ${whole.format(data.counts.onlyB)} only in ${data.b.name}`}
            description={`${whole.format(data.same)} items are the same.`}
            aside={<span className="text-[12px] text-faint" title={fmtDate(data.generatedAt)}>As of {new Date(data.generatedAt).toLocaleTimeString()}</span>} />
          <div className="grid gap-3 border-b border-line px-5 py-3 sm:grid-cols-2 md:max-w-xl">
            <Field label="Kind">
              <select className="input" value={kind} onChange={(e) => { setKind(e.target.value); setOffset(0); }}>
                <option value="">Everything</option>
                {INDEX_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
              </select>
            </Field>
            <Field label="Show">
              <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
                <option value="">Every difference</option>
                <option value="different">Different values</option>
                <option value="only-a">Only in {data.a.name}</option>
                <option value="only-b">Only in {data.b.name}</option>
              </select>
            </Field>
          </div>
          {!data.diffs.length ? <p className="px-5 py-8 text-center text-sm text-muted">No differences{kind || status ? ' of this kind' : ''}.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">What</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{data.a.name}</th>
                    <th scope="col" className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{data.b.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.diffs.map((d) => (
                    <tr key={d.item} className="border-b border-line/60 align-top last:border-0 hover:bg-raised/40">
                      <td className="max-w-[320px] px-4 py-2.5">
                        <Badge className="mr-1.5">{KIND_LABEL[d.kind] ?? d.kind}</Badge>
                        <span className="break-words text-ink-2">{d.path}</span>
                        {d.status !== 'different' && <Badge tone="warn" className="ml-1.5">only in {d.status === 'only-a' ? 'A' : 'B'}</Badge>}
                      </td>
                      <td className="max-w-[360px] px-4 py-2.5"><Values v={d.a} /></td>
                      <td className="max-w-[360px] px-4 py-2.5"><Values v={d.b} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager offset={data.offset} limit={data.limit} shown={data.diffs.length} total={data.total} onPage={setOffset} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><ZonesCompare /></Suspense>;
}
