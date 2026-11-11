'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeftRight, Download, RefreshCw } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { groupOf, whatOf } from '@/lib/zone-diff-groups';
import type { ZoneDiffPage } from '@/lib/compare';
import { Alert, Badge, Button, Card, EmptyState, Field, Loading, PageHeader, SectionHeader, SkeletonTable } from '@/components/ui';
import { Pager, Values, ZonePicker } from '../parts';

import { whole } from '@/lib/num';
const PAGE = 50;
type Answer = ZoneDiffPage & { generatedAt: string };
type Pick = { id: string; name: string } | null;

function ZonesCompare() {
  const params = useSearchParams();
  const router = useRouter();
  const a = params.get('a') ?? '', b = params.get('b') ?? '';
  const [za, setA] = useState<Pick>(a ? { id: a, name: a } : null);
  const [zb, setB] = useState<Pick>(b ? { id: b, name: b } : null);
  const [group, setGroup] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!a || !b) { setData(null); return; }
    setLoading(true);
    const u = new URLSearchParams({ a, b, offset: String(offset), limit: String(PAGE) });
    if (group) u.set('group', group);
    if (status) u.set('status', status);
    try {
      const r = await api<Answer>(`/api/compare/zone-diff?${u}`);
      setData(r); setError('');
      // The names the server knows (a link may carry only ids).
      setA((x) => (x?.id === r.a.id ? { id: r.a.id, name: r.a.name } : x));
      setB((x) => (x?.id === r.b.id ? { id: r.b.id, name: r.b.name } : x));
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [a, b, group, status, offset]);
  useEffect(() => { void load(); }, [load]);

  /** The report of what is shown (the type and status chosen), every difference, no paging. */
  const reportHref = (format: string) => {
    const u = new URLSearchParams({ a, b, format });
    if (group) u.set('group', group);
    if (status) u.set('status', status);
    return `/api/compare/zone-diff/report?${u}`;
  };

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
            aside={<span className="text-[12px] text-faint" title={fmtDate(data.generatedAt)}>As of {fmtDate(data.generatedAt)}</span>} />
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <span className="text-[12.5px] text-muted">Download the report{group || status ? ' (of what is shown)' : ''}:</span>
            {([['docx', 'Word'], ['html', 'HTML (prints to PDF)'], ['csv', 'CSV']] as const).map(([f, label]) => (
              <a key={f} href={reportHref(f)} download className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-raised hover:text-ink">
                <Download className="size-3.5" /> {label}
              </a>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 border-b border-line px-5 py-3">
            {data.groups.map((g) => (
              <button key={g.key} type="button" aria-pressed={group === g.key} onClick={() => { setGroup(group === g.key ? '' : g.key); setOffset(0); }}
                className={`rounded-lg border px-2.5 py-1 text-left text-[12.5px] ${group === g.key ? 'border-signal bg-signal/10 text-ink' : 'border-line text-muted hover:text-ink'}`}>
                <span className="font-medium">{g.label}</span> <span className="tabular-nums">{whole.format(g.total)}</span>
                <span className="ml-1 text-[11px] text-faint">({[g.different && `${whole.format(g.different)} different`, g.onlyA && `${whole.format(g.onlyA)} only A`, g.onlyB && `${whole.format(g.onlyB)} only B`].filter(Boolean).join(' · ')})</span>
              </button>
            ))}
          </div>
          <div className="grid gap-3 border-b border-line px-5 py-3 sm:grid-cols-2 md:max-w-xl">
            <Field label="Type">
              <select className="input" value={group} onChange={(e) => { setGroup(e.target.value); setOffset(0); }}>
                <option value="">Everything ({whole.format(data.counts.different + data.counts.onlyA + data.counts.onlyB)})</option>
                {data.groups.map((g) => <option key={g.key} value={g.key}>{g.label} ({whole.format(g.total)})</option>)}
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
          {!data.diffs.length ? <p className="px-5 py-8 text-center text-sm text-muted">No differences{group || status ? ' of this kind' : ''}.</p> : (
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
                  {data.diffs.map((d, i) => {
                    const g = groupOf(d);
                    const first = i === 0 || groupOf(data.diffs[i - 1]).key !== g.key;
                    return [
                      first && (
                        <tr key={`h:${g.key}`} className="border-b border-line bg-sunken/60">
                          <th colSpan={3} scope="colgroup" className="px-4 py-2 text-left text-[12.5px] font-semibold text-ink">
                            {g.label} <span className="font-normal text-muted">· {whole.format(data.groups.find((x) => x.key === g.key)?.total ?? 0)} differences</span>
                          </th>
                        </tr>
                      ),
                      <tr key={d.item} className="border-b border-line/60 align-top last:border-0 hover:bg-raised/40">
                        <td className="max-w-[320px] px-4 py-2.5">
                          <span className="break-words text-ink-2">{whatOf(d)}</span>
                          {d.status !== 'different' && <Badge tone="warn" className="ml-1.5">only in {d.status === 'only-a' ? 'A' : 'B'}</Badge>}
                          <div className="mt-0.5 font-mono text-[11px] break-all text-faint">{d.item}</div>
                        </td>
                        <td className="max-w-[360px] px-4 py-2.5"><Values v={d.a} /></td>
                        <td className="max-w-[360px] px-4 py-2.5"><Values v={d.b} /></td>
                      </tr>,
                    ];
                  })}
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
