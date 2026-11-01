'use client';

import { compactNum } from '@/lib/num';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Play, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { AUDIT_WINDOWS, DEFAULT_WINDOW, windowLabel, type AuditListItem } from '@/lib/zone-audit/types';
import { Alert, Button, Card, EmptyState, Loading, PageHeader, SectionHeader, Segmented, SkeletonTable, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useSnapshot } from '../monitoring/use-run';
import { ZonePicker, type PickedZone } from '../investigate/shared';
import { AuditState, SeverityCounts } from './audit-view';

interface ListView { audits: AuditListItem[]; total: number; offset: number; limit: number; generatedAt: string }
interface HistoryView { audits: AuditListItem[]; generatedAt: string }
type Sort = 'worst' | 'newest' | 'name';

const PAGE = 50;

/** The newest audits of one zone (at most 20 are kept). */
function ZoneHistory({ zone }: { zone: PickedZone }) {
  const { data, error, loading, reload } = useSnapshot<HistoryView>(`/api/security-audit?zone=${encodeURIComponent(zone.id)}`);
  return (
    <Card>
      <SectionHeader title={`Audits of ${zone.name}`} description="The newest 20 are kept."
        aside={<Button size="sm" variant="ghost" loading={loading && !!data} onClick={reload} icon={<RefreshCw className="size-3.5" />}>Refresh</Button>} />
      {error && <div className="px-5 pt-3"><Alert tone="bad">{error}</Alert></div>}
      {!data ? !error && <div className="px-5 py-3"><SkeletonTable rows={3} cols={4} /></div>
        : !data.audits.length ? <p className="px-5 py-4 text-[13px] text-muted">This zone has not been audited yet.</p>
          : <AuditTable audits={data.audits} showZone={false} />}
      {data && <p className="px-5 pb-3 text-xs text-faint">As of {fmtDate(data.generatedAt)}</p>}
    </Card>
  );
}

function AuditTable({ audits, showZone }: { audits: AuditListItem[]; showZone: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            {showZone && <th scope="col" className="px-5 py-2.5 font-medium">Zone</th>}
            <th scope="col" className="px-5 py-2.5 font-medium">Started</th>
            <th scope="col" className="px-3 py-2.5 font-medium">State</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Findings</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Not read</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {audits.map((a) => (
            <tr key={a.id}>
              {showZone && <td className="px-5 py-2.5 align-top"><Link href={`/console/security-audit/${a.id}`} className="font-medium text-ink hover:text-signal">{a.zoneName || a.zoneId}</Link></td>}
              <td className="px-5 py-2.5 align-top">
                {showZone ? <span title={fmtDate(a.startedAt)}>{relTime(a.startedAt)}</span>
                  : <Link href={`/console/security-audit/${a.id}`} className="text-ink hover:text-signal" title={fmtDate(a.startedAt)}>{fmtDate(a.startedAt)}</Link>}
                {a.startedBy && <div className="text-xs text-faint">{a.startedBy}</div>}
              </td>
              <td className="px-3 py-2.5 align-top"><AuditState status={a.status} /></td>
              <td className="px-3 py-2.5 align-top">{a.summary ? <SeverityCounts s={a.summary} /> : <span className="text-faint">—</span>}</td>
              <td className="px-5 py-2.5 align-top tabular-nums">{a.summary ? <span className={cx(a.summary.coverage.not_read ? 'text-warn' : 'text-muted')}>{a.summary.coverage.not_read} of {a.summary.rules} rules</span> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SecurityAuditPage() {
  const router = useRouter();
  const toast = useToast();
  const [zone, setZone] = useState<PickedZone | null>(null);
  const [hours, setHours] = useState<string>(String(DEFAULT_WINDOW));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [sort, setSort] = useState<Sort>('worst');
  const [offset, setOffset] = useState(0);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const list = useSnapshot<ListView>(`/api/security-audit?sort=${sort}&offset=${offset}&limit=${PAGE}${q ? `&q=${encodeURIComponent(q)}` : ''}`);

  // ?zone=ID (from the Zone explorer): that zone, chosen.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('zone');
    if (!id) return;
    let live = true;
    api<{ zones: PickedZone[] }>(`/api/investigate/zones?limit=5&q=${encodeURIComponent(id)}`).then((r) => { const z = r.zones.find((x) => x.id === id); if (live && z) setZone(z); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const start = async () => {
    if (!zone) return;
    setStarting(true); setStartError('');
    try {
      const r = await api<{ audit: AuditListItem }>('/api/security-audit', { method: 'POST', json: { zoneId: zone.id, hours: Number(hours) } });
      toast(r.audit.status === 'running' ? `Auditing ${zone.name}…` : `Audit of ${zone.name} finished`, 'ok');
      router.push(`/console/security-audit/${r.audit.id}`);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Security" title="Security audit"
        description="Checks one zone against a fixed set of rules taken from the security-audit methodology: transport, origin exposure, email spoofing, WAF, availability, cache, host trust, client-side headers and edge Workers — plus how each security rule acted on the zone's traffic. Read-only: nothing is changed in Cloudflare, and there is no AI involved; every rule is a documented condition." />
      <Card className="space-y-4 p-5">
        <ZonePicker label="Zone" value={zone} onChange={setZone} hint="Any zone a stored credential can read." />
        <div className="space-y-1.5">
          <span className="text-[13px] font-medium text-ink-2" id="audit-window">Traffic window</span>
          <div role="group" aria-labelledby="audit-window">
            <Segmented value={hours} onChange={setHours} options={AUDIT_WINDOWS.map((h) => ({ value: String(h), label: windowLabel(h), hint: h === DEFAULT_WINDOW ? 'Default' : h === 720 ? 'Shortened to what the plan keeps' : undefined }))} />
          </div>
        </div>
        {startError && <Alert tone="bad" title="The audit could not start">{startError}</Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!zone} loading={starting} onClick={start} icon={<Play className="size-4" />}>Run audit</Button>
          <span className="text-xs text-muted">About 30 Cloudflare API reads, up to 40 public DNS lookups and a few analytics queries per audit. One audit per zone at a time.</span>
        </div>
      </Card>
      {zone && <ZoneHistory key={zone.id} zone={zone} />}
      <Card>
        <SectionHeader title="Latest audit of each zone" description="Only zones that have been audited. Sorted by the worst finding."
          aside={<Button size="sm" variant="ghost" loading={list.loading && !!list.data} onClick={list.reload} icon={<RefreshCw className="size-3.5" />}>Refresh</Button>} />
        <div className="flex flex-wrap items-end gap-3 px-5 pt-3">
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setOffset(0); setQ(typed.trim()); }}>
            <div className="space-y-1">
              <label htmlFor="audit-q" className="text-xs text-muted">Zone name</label>
              <input id="audit-q" className="input w-56" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Filter…" />
            </div>
            <Button type="submit" size="sm" icon={<Search className="size-3.5" />}>Filter</Button>
          </form>
          <div className="space-y-1">
            <label htmlFor="audit-sort" className="text-xs text-muted">Sort</label>
            <select id="audit-sort" className="input" value={sort} onChange={(e) => { setOffset(0); setSort(e.target.value as Sort); }}>
              <option value="worst">Worst finding first</option><option value="newest">Newest first</option><option value="name">Zone name</option>
            </select>
          </div>
        </div>
        {list.error && <div className="px-5 pt-3"><Alert tone="bad" title="Audits could not be read">{list.error}</Alert></div>}
        <div className="pt-3">
          {!list.data ? !list.error && <Loading label="Loading audits"><div className="px-5"><SkeletonTable rows={5} cols={5} /></div></Loading>
            : !list.data.audits.length ? <EmptyState icon={<ShieldCheck className="size-5" />} title={q ? 'No audited zone matches' : 'No audits yet'} description="Choose a zone above and run an audit." />
              : <AuditTable audits={list.data.audits} showZone />}
        </div>
        {list.data && list.data.total > 0 && (
          <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-muted">
            <span>{list.data.offset + 1}–{list.data.offset + list.data.audits.length} of {compactNum(list.data.total)} · As of {fmtDate(list.data.generatedAt)}</span>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
              <Button size="sm" variant="ghost" disabled={list.data.offset + list.data.audits.length >= list.data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
