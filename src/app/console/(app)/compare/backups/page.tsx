'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { GitCompare, RefreshCw } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import type { BackupDiffPage } from '@/lib/compare';
import type { BackupRef } from '@/lib/backup-sources';
import { Alert, Badge, Button, Card, EmptyState, Field, Loading, PageHeader, SectionHeader, SkeletonTable } from '@/components/ui';
import { Pager, Values, ZonePicker } from '../parts';

const whole = new Intl.NumberFormat();
const PAGE = 50;
type List = { zone: { id: string; name: string }; backups: BackupRef[]; problems: string[]; generatedAt: string };
type Answer = BackupDiffPage & { generatedAt: string };
const label = (b: BackupRef) => `${new Date(b.time).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${b.where}${b.partial ? ' · partial' : ''}`;
const TONE = { added: 'ok', removed: 'bad', changed: 'warn' } as const;

function BackupsCompare() {
  const params = useSearchParams();
  const router = useRouter();
  const zoneId = params.get('zone') ?? '';
  const a = params.get('a') ?? '', b = params.get('b') ?? '';
  const [zone, setZone] = useState<{ id: string; name: string } | null>(zoneId ? { id: zoneId, name: zoneId } : null);
  const [list, setList] = useState<List | null>(null);
  const [listError, setListError] = useState('');
  const [pick, setPick] = useState({ a, b });
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async () => {
    if (!zoneId) { setList(null); return; }
    try {
      const r = await api<List>(`/api/compare/backups?zone=${encodeURIComponent(zoneId)}`);
      setList(r); setListError(''); setZone(r.zone);
      // Newest two by default: what changed in the last backup.
      setPick((p) => (p.a || p.b ? p : { a: r.backups[1]?.ref ?? '', b: r.backups[0]?.ref ?? '' }));
    } catch (e) { setListError((e as Error).message); }
  }, [zoneId]);
  useEffect(() => { void loadList(); }, [loadList]);

  const load = useCallback(async () => {
    if (!zoneId || !a || !b) { setData(null); return; }
    setLoading(true);
    const u = new URLSearchParams({ zone: zoneId, a, b, offset: String(offset), limit: String(PAGE) });
    if (type) u.set('type', type);
    try { setData(await api<Answer>(`/api/compare/backup-diff?${u}`)); setError(''); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [zoneId, a, b, type, offset]);
  useEffect(() => { void load(); }, [load]);

  const chooseZone = (z: { id: string; name: string } | null) => {
    setZone(z);
    setPick({ a: '', b: '' });
    setData(null);
    router.replace(z ? `/console/compare/backups?zone=${encodeURIComponent(z.id)}` : '/console/compare/backups');
  };
  const compare = () => {
    setOffset(0);
    router.replace(`/console/compare/backups?zone=${encodeURIComponent(zoneId)}&a=${encodeURIComponent(pick.a)}&b=${encodeURIComponent(pick.b)}`);
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Compare" title="Backup vs backup"
        description="What changed in one zone between two backups, resource by resource and attribute by attribute, from the Terraform files. Read-only: to undo a change, use Restore."
        actions={zoneId ? <Button variant="ghost" loading={loading} onClick={() => { void loadList(); void load(); }} icon={<RefreshCw className="size-4" />}>Refresh</Button> : undefined} />
      <Card>
        <div className="grid gap-4 p-5 md:grid-cols-[1fr_1fr_1fr_auto] md:items-end">
          <ZonePicker label="Zone" value={zone} onChange={chooseZone} />
          <Field label="Before">
            <select className="input" value={pick.a} disabled={!list?.backups.length} onChange={(e) => setPick({ ...pick, a: e.target.value })}>
              <option value="">Choose a backup</option>
              {list?.backups.map((x) => <option key={x.ref} value={x.ref}>{label(x)}</option>)}
            </select>
          </Field>
          <Field label="After">
            <select className="input" value={pick.b} disabled={!list?.backups.length} onChange={(e) => setPick({ ...pick, b: e.target.value })}>
              <option value="">Choose a backup</option>
              {list?.backups.map((x) => <option key={x.ref} value={x.ref}>{label(x)}</option>)}
            </select>
          </Field>
          <Button variant="primary" disabled={!pick.a || !pick.b || pick.a === pick.b} onClick={compare} icon={<GitCompare className="size-4" />}>Compare</Button>
        </div>
        {listError && <p className="px-5 pb-4 text-sm text-bad">{listError}</p>}
        {list && !list.backups.length && <p className="px-5 pb-4 text-sm text-muted">No backup of {list.zone.name} was found on this server or in the approved buckets.</p>}
        {list && list.backups.length === 1 && <p className="px-5 pb-4 text-sm text-muted">Only one backup of {list.zone.name} was found: there is nothing to compare it with yet.</p>}
        {list?.problems.map((p) => <p key={p} className="px-5 pb-3 text-xs text-warn">{p}</p>)}
      </Card>
      {error && <Alert tone="bad" title="The comparison failed">{error}</Alert>}
      {!zoneId || !a || !b ? (
        <Card><EmptyState icon={<GitCompare className="size-5" />} title="Choose a zone and two backups" description="Backups are read from this server's backup folders and the approved R2 / S3 buckets." /></Card>
      ) : !data ? <Loading label="Comparing"><SkeletonTable rows={8} cols={3} /></Loading> : (
        <Card>
          <SectionHeader title={`${whole.format(data.counts.changed)} changed · ${whole.format(data.counts.added)} added · ${whole.format(data.counts.removed)} removed`}
            description={`${data.zone.name}: ${label(data.a)} → ${label(data.b)}. ${whole.format(data.counts.unchanged)} resources unchanged.`}
            aside={<span className="text-[12px] text-faint" title={fmtDate(data.generatedAt)}>As of {new Date(data.generatedAt).toLocaleTimeString()}</span>} />
          {data.types.length > 1 && (
            <div className="border-b border-line px-5 py-3 md:max-w-xs">
              <Field label="Resource type">
                <select className="input" value={type} onChange={(e) => { setType(e.target.value); setOffset(0); }}>
                  <option value="">Every type</option>
                  {data.types.map((t) => <option key={t} value={t}>{t.replace(/^cloudflare_/, '')}</option>)}
                </select>
              </Field>
            </div>
          )}
          {!data.changes.length ? <p className="px-5 py-8 text-center text-sm text-muted">Nothing changed between these backups.</p> : (
            <ul>
              {data.changes.map((c) => (
                <li key={`${c.key}:${c.change}`} className="border-b border-line/60 px-5 py-3 last:border-0">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <Badge tone={TONE[c.change]}>{c.change}</Badge>
                    <span className="font-mono text-[12px] text-muted">{c.type.replace(/^cloudflare_/, '')}</span>
                    <span className="font-medium break-all">{c.name}</span>
                  </div>
                  {c.change === 'changed' && (
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[640px] text-left text-[12.5px]">
                        <thead><tr className="text-muted"><th scope="col" className="py-1 pr-3 font-medium">Attribute</th><th scope="col" className="py-1 pr-3 font-medium">Before</th><th scope="col" className="py-1 font-medium">After</th></tr></thead>
                        <tbody>
                          {c.attrs.slice(0, 50).map((x) => (
                            <tr key={x.path} className="align-top">
                              <td className="py-1 pr-3 font-mono text-[12px] break-all text-ink-2">{x.path}</td>
                              <td className="max-w-[360px] py-1 pr-3"><Values v={[x.before]} /></td>
                              <td className="max-w-[360px] py-1"><Values v={[x.after]} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {c.attrs.length > 50 && <p className="mt-1 text-xs text-muted">and {whole.format(c.attrs.length - 50)} more attributes</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Pager offset={data.offset} limit={data.limit} shown={data.changes.length} total={data.total} onPage={setOffset} />
        </Card>
      )}
    </div>
  );
}

export default function Page() {
  return <Suspense><BackupsCompare /></Suspense>;
}
