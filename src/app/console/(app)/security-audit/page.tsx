'use client';

import { compactNum } from '@/lib/num';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Play, RefreshCw, Search, ShieldCheck, Square } from 'lucide-react';
import { api, fmtDate, isAbort, relTime } from '@/lib/client';
import { AUDIT_WINDOWS, DEFAULT_WINDOW, SEVERITIES, windowLabel, type AccountAuditView, type AuditListItem } from '@/lib/zone-audit/types';
import { Alert, Badge, Button, Card, EmptyState, Loading, Modal, PageHeader, SectionHeader, Segmented, Skeleton, SkeletonTable, cx } from '@/components/ui';
import { SeverityBadge } from '@/components/monitor-view';
import { useMe } from '@/components/me';
import { usePoll } from '@/components/use-poll';
import { useToast } from '@/components/toast';
import { useSnapshot } from '../monitoring/use-run';
import { ZonePicker, useAccounts, type PickedZone } from '../investigate/shared';
import { AuditState, SeverityCounts } from './audit-view';

interface ListView { audits: AuditListItem[]; total: number; offset: number; limit: number; generatedAt: string }
interface HistoryView { audits: AuditListItem[]; generatedAt: string }
type Sort = 'worst' | 'newest' | 'name';

const PAGE = 50;
/** Account audits run two zones at a time, each about a minute: the estimate shown before starting. */
const ZONES_PER_MINUTE = 2;

const duration = (zones: number) => {
  const min = Math.max(1, Math.ceil(zones / ZONES_PER_MINUTE));
  return min < 90 ? `about ${min} minute${min === 1 ? '' : 's'}` : `about ${Math.round(min / 60)} hours`;
};

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

/** The account audit running now (or the last one): asked again every few seconds while it runs. */
function AccountProgress({ view, onChange, onDone }: { view: AccountAuditView; onChange: (v: AccountAuditView | null) => void; onDone: () => void }) {
  const { can, user } = useMe();
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const live = view.state === 'running';
  const poll = useCallback(async (signal: AbortSignal) => {
    try {
      const r = await api<{ account: AccountAuditView | null }>('/api/security-audit/account', { signal });
      onChange(r.account);
      if (r.account?.state !== 'running') onDone();
    } catch (e) { if (!isAbort(e)) throw e; }
  }, [onChange, onDone]);
  usePoll(poll, 5_000, { on: live, now: false });
  const done = view.ready + view.failed + view.skipped;
  const pct = view.total ? Math.round((done / view.total) * 100) : 0;
  const stop = async () => {
    setStopping(true);
    try {
      const r = await api<{ account: AccountAuditView | null }>('/api/security-audit/account', { method: 'DELETE' });
      onChange(r.account);
      toast('No further zones will start; the ones being audited finish', 'info');
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setStopping(false); }
  };
  return (
    <Card>
      <SectionHeader title={`Every zone in ${view.accountName}`}
        description={`Started ${relTime(view.startedAt)}${view.startedBy ? ` by ${view.startedBy}` : ''} · ${windowLabel(view.hours)} traffic window`}
        aside={live ? <Badge tone="signal">Running</Badge> : view.state === 'stopped' ? <Badge tone="warn">Stopped</Badge> : <Badge tone="ok">Finished</Badge>} />
      <div className="space-y-3 px-5 py-4">
        <div className="h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label="Zones audited" aria-valuemin={0} aria-valuemax={view.total} aria-valuenow={done}>
          <div className="h-full rounded-full bg-signal transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[13px] tabular-nums text-ink-2">
          {compactNum(done)} of {compactNum(view.total)} zones done
          {live && <> · {view.running} being audited · {compactNum(view.queued)} waiting · {duration(view.queued + view.running)} left</>}
          {view.failed > 0 && <span className="text-bad"> · {compactNum(view.failed)} failed</span>}
          {view.skipped > 0 && <span className="text-warn"> · {compactNum(view.skipped)} skipped</span>}
        </p>
        {view.ready > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <span>Worst finding per zone:</span>
            {SEVERITIES.filter((v) => view.worst[v]).map((v) => <span key={v} className="inline-flex items-center gap-1"><SeverityBadge s={v} /><span className="tabular-nums text-ink-2">{compactNum(view.worst[v]!)}</span></span>)}
            {!!view.worst.none && <span className="tabular-nums">No findings: {compactNum(view.worst.none)}</span>}
          </div>
        )}
        {view.problems.length > 0 && (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-ink-2">Zones that failed or were skipped ({compactNum(view.failed + view.skipped)})</summary>
            <ul className="mt-2 space-y-1">
              {view.problems.map((p) => <li key={p.zoneId}><span className="font-medium text-ink">{p.zoneName}</span> <span className={p.kind === 'failed' ? 'text-bad' : 'text-warn'}>{p.kind}</span> <span className="text-muted">— {p.reason}</span></li>)}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted">Each zone’s report appears in “Latest audit of each zone” below as it finishes.</span>
          {live && (view.startedBy === user.email || can('runs:cancel')) && <Button size="sm" variant="ghost" loading={stopping} onClick={stop} icon={<Square className="size-3.5" />}>Stop</Button>}
        </div>
      </div>
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
  const accounts = useAccounts();
  const [picked, setAccountId] = useState('');
  // One account: nothing to choose.
  const accountId = picked || (accounts?.length === 1 ? accounts[0].id : '');
  const [zone, setZone] = useState<PickedZone | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [batch, setBatch] = useState<AccountAuditView | null>(null);
  const [hours, setHours] = useState<string>(String(DEFAULT_WINDOW));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [sort, setSort] = useState<Sort>('worst');
  const [offset, setOffset] = useState(0);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const list = useSnapshot<ListView>(`/api/security-audit?sort=${sort}&offset=${offset}&limit=${PAGE}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const account = accounts?.find((a) => a.id === accountId);
  // The account first, then (optionally) one of its zones: the same zone name can exist in two accounts.
  const pickAccount = (id: string) => { setAccountId(id); setZone(null); setStartError(''); };
  const reloadList = list.reload;
  const batchDone = useCallback(() => { void reloadList(); }, [reloadList]);

  // ?zone=ID (from the Zone explorer): that zone and its account, chosen.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('zone');
    if (!id) return;
    let live = true;
    api<{ zones: PickedZone[] }>(`/api/investigate/zones?limit=5&q=${encodeURIComponent(id)}`).then((r) => { const z = r.zones.find((x) => x.id === id); if (live && z) { setAccountId(z.accountId); setZone(z); } }).catch(() => {});
    return () => { live = false; };
  }, []);
  // The account audit running now (or the last one), so a reload or another person sees its progress.
  useEffect(() => {
    let live = true;
    api<{ account: AccountAuditView | null }>('/api/security-audit/account').then((r) => { if (live) setBatch(r.account); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const start = async () => {
    if (!account) return;
    setStarting(true); setStartError('');
    if (!zone) {
      try {
        const r = await api<{ account: AccountAuditView }>('/api/security-audit', { method: 'POST', json: { accountId: account.id, hours: Number(hours) } });
        setBatch(r.account);
        toast(`Auditing ${compactNum(r.account.total)} zones in ${r.account.accountName}…`, 'ok');
      } catch (e) { setStartError(e instanceof Error ? e.message : String(e)); }
      setConfirmAll(false); setStarting(false);
      return;
    }
    try {
      const r = await api<{ audit: AuditListItem }>('/api/security-audit', { method: 'POST', json: { accountId: account.id, zoneId: zone.id, hours: Number(hours) } });
      toast(r.audit.status === 'running' ? `Auditing ${zone.name}…` : `Audit of ${zone.name} finished`, 'ok');
      router.push(`/console/security-audit/${r.audit.id}`);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };
  const batchRunning = batch?.state === 'running';

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Security" title="Security audit"
        description="Checks one zone, or every zone of an account, against a fixed set of rules taken from the security-audit methodology: transport, origin exposure, email spoofing, WAF, availability, cache, host trust, client-side headers and edge Workers — plus how each security rule acted on the zone's traffic. Read-only: nothing is changed in Cloudflare, and there is no AI involved; every rule is a documented condition." />
      <Card className="space-y-4 p-5">
        <div className="space-y-1.5">
          <label htmlFor="audit-account" className="text-[13px] font-medium text-ink-2">Account</label>
          {!accounts ? <Skeleton className="h-10 w-full rounded-[9px]" /> : (
            <select id="audit-account" className="input" value={accountId} onChange={(e) => pickAccount(e.target.value)}>
              <option value="">{accounts.length ? 'Choose an account' : 'No account a stored credential reads'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({compactNum(a.zones)} zone{a.zones === 1 ? '' : 's'})</option>)}
            </select>
          )}
        </div>
        <ZonePicker key={accountId} label="Zone (optional)" value={zone} onChange={setZone} accountId={accountId || undefined} disabled={!account}
          placeholder={account ? `All ${compactNum(account.zones)} zones — or type a zone name…` : 'Choose an account first'}
          hint={!account ? 'The zones of the chosen account.' : zone ? `Audits ${zone.name} only. Clear the box to audit every zone in ${account.name}.` : `Leave empty to audit every zone in ${account.name}, or pick one zone.`} />
        <div className="space-y-1.5">
          <span className="text-[13px] font-medium text-ink-2" id="audit-window">Traffic window</span>
          <div role="group" aria-labelledby="audit-window">
            <Segmented value={hours} onChange={setHours} options={AUDIT_WINDOWS.map((h) => ({ value: String(h), label: windowLabel(h), hint: h === DEFAULT_WINDOW ? 'Default' : h === 720 ? 'Shortened to what the plan keeps' : undefined }))} />
          </div>
        </div>
        {startError && <Alert tone="bad" title="The audit could not start">{startError}</Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" disabled={!account || (!zone && batchRunning)} loading={starting && !confirmAll} onClick={() => (zone ? start() : setConfirmAll(true))} icon={<Play className="size-4" />}>
            {zone || !account ? 'Run audit' : `Audit all ${compactNum(account.zones)} zones`}
          </Button>
          <span className="text-xs text-muted">
            {!zone && batchRunning ? 'An account audit is running — wait for it or stop it below. ' : ''}
            About 30 Cloudflare API reads, up to 40 public DNS lookups and a few analytics queries per zone. One audit per zone, and one account audit, at a time.
          </span>
        </div>
      </Card>
      {batch && <AccountProgress view={batch} onChange={setBatch} onDone={batchDone} />}
      {zone && <ZoneHistory key={zone.id} zone={zone} />}
      <Modal open={confirmAll} onClose={() => setConfirmAll(false)} title={`Audit every zone in ${account?.name ?? 'the account'}?`}
        description={`${compactNum(account?.zones ?? 0)} zones, two at a time: ${duration(account?.zones ?? 0)}. Read-only — nothing is changed in Cloudflare.`}
        footer={<><Button variant="ghost" onClick={() => setConfirmAll(false)}>Cancel</Button><Button variant="primary" loading={starting} onClick={start} icon={<Play className="size-4" />}>Audit all zones</Button></>}>
        <p className="text-[13px] text-muted">Each zone takes about 30 Cloudflare API reads with the stored token. A zone being audited already is skipped. You can leave this page: the progress shows here, and the audit can be stopped at any time.</p>
      </Modal>
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
            : !list.data.audits.length ? <EmptyState icon={<ShieldCheck className="size-5" />} title={q ? 'No audited zone matches' : 'No audits yet'} description="Choose an account (and a zone, or none for all of them) above and run an audit." />
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
