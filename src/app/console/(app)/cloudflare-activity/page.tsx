'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Cloud, Copy, Download, History as HistoryIcon, Lock, RefreshCw, Search, Undo2 } from 'lucide-react';
import { api, copyText, fmtDate } from '@/lib/client';
import { zoneList } from '@/lib/zone-list-client';
import type { CredentialOption } from '@/lib/kinds';
import {
  CATEGORIES, CATEGORY_LABEL, CF_RANGES, actorLabel, byAccount, byCategory, changeTitle, contextLabel, filterChanges, summaryText, totals, zoneLabel,
  type CategoryKey, type CfAuditReport, type CfChange, type CfHistoryResult, type CfRange, type CfZoneEvent, type Tally,
} from '@/lib/cf-audit-report';
import { Alert, Badge, Button, Card, EmptyState, Field, Loading, Modal, PageHeader, Skeleton, SkeletonStats, Stat, cx } from '@/components/ui';
import type { CfRevertPlan } from '@/lib/cf-revert';
import { useToast } from '@/components/toast';
import { useMe } from '@/components/me';

type View = 'category' | 'zone' | 'timeline';
const VIEWS: { value: View; label: string }[] = [
  { value: 'category', label: 'By category' },
  { value: 'zone', label: 'By account & zone' },
  { value: 'timeline', label: 'Timeline' },
];
const TIMELINE_PAGE = 200;
const FIELD_ROWS = 6;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Custom periods are whole UTC days, so show them as chosen; rolling ones in local time. */
const periodText = (r: CfAuditReport) => {
  if (r.range !== 'custom') return `${fmtDate(r.since)} → ${fmtDate(r.before)}`;
  const d = (ms: number) => new Date(ms).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
  const end = Date.parse(r.before);
  // `before` is exclusive (next midnight) unless it was cut to "now".
  return `${d(Date.parse(r.since))} – ${d(end % 86_400_000 === 0 ? end - 86_400_000 : end)} (UTC)`;
};

const CATEGORY_TONE: Partial<Record<CategoryKey, 'signal' | 'warn' | 'info' | 'bad' | 'ok'>> = {
  onboarding: 'ok', dns: 'info', security: 'bad', cdn: 'signal', rules: 'signal', ssl: 'warn', access: 'warn',
};
const EVENT_TONE = { added: 'ok', activated: 'info', removed: 'warn' } as const;
const EVENT_LABEL = { added: 'Added', activated: 'Activated', removed: 'Removed' } as const;

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cx('rounded-lg border px-3 py-1.5 text-[13px] transition-colors', active ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted hover:text-ink-2')}>
      {children}
    </button>
  );
}

function TallyBadges({ t }: { t: Tally }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {t.create > 0 && <Badge tone="ok">+{t.create} created</Badge>}
      {t.update > 0 && <Badge tone="info">{t.update} updated</Badge>}
      {t.delete > 0 && <Badge tone="warn">−{t.delete} deleted</Badge>}
      {t.failed > 0 && <Badge tone="bad">{t.failed} failed</Badge>}
    </span>
  );
}

function Group({ title, sub, tally, children, defaultOpen, level = 0 }: { title: ReactNode; sub?: ReactNode; tally: Tally; children: ReactNode; defaultOpen?: boolean; level?: number }) {
  return (
    <details open={defaultOpen} className={cx('group/d', level === 0 ? 'border-b border-line/60 last:border-0' : 'border-t border-line/40')}>
      <summary className={cx('flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 py-3 hover:bg-raised/40 [&::-webkit-details-marker]:hidden', level === 0 ? 'px-5' : level === 1 ? 'pr-5 pl-9' : 'pr-5 pl-14')}>
        <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-open/d:rotate-90" aria-hidden />
        <span className={cx('min-w-0 break-words', level === 0 ? 'text-[14px] font-semibold' : 'text-[13px] font-medium')}>{title}</span>
        {sub && <span className="text-xs text-muted">{sub}</span>}
        <span className="ml-auto flex items-center gap-2">
          <TallyBadges t={tally} />
          <span className="font-mono text-[12px] text-muted tabular-nums">{tally.total}</span>
        </span>
      </summary>
      <div className="pb-2">{children}</div>
    </details>
  );
}

function FieldTable({ c, history }: { c: CfChange; history?: CfHistoryResult }) {
  const [all, setAll] = useState(false);
  const rows = history?.changes.length ? history.changes : c.changes;
  if (!rows.length) return null;
  const showOld = rows.some((f) => f.old !== undefined) || c.actionType === 'update';
  const showNew = rows.some((f) => f.new !== undefined);
  const visible = all ? rows : rows.slice(0, FIELD_ROWS);
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[420px] text-left text-[12px]">
        <thead className="bg-raised/50 text-muted">
          <tr>
            <th className="w-[28%] min-w-[150px] px-3 py-1.5 font-medium">Field</th>
            {showOld && <th className="px-3 py-1.5 font-medium">Old value</th>}
            {showNew && <th className="px-3 py-1.5 font-medium">New value</th>}
          </tr>
        </thead>
        <tbody className="font-mono">
          {visible.map((f, i) => (
            <tr key={`${f.path}-${i}`} className="border-t border-line/50 align-top">
              <td className="px-3 py-1.5 break-all text-ink-2">{f.path}</td>
              {showOld && <td className={cx('px-3 py-1.5 break-all', f.old !== undefined ? 'text-bad/90' : 'text-faint')}>{f.old ?? (c.oldSource === 'lookup' && !history ? 'not in this period' : '—')}</td>}
              {showNew && <td className={cx('px-3 py-1.5 break-all', f.new !== undefined ? 'text-ok' : 'text-faint')}>{f.new ?? (c.actionType === 'delete' ? 'deleted' : '—')}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > FIELD_ROWS && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-line/50 px-3 py-1.5 text-left text-xs text-muted hover:text-ink">
          {all ? 'Show fewer fields' : `Show all ${rows.length} fields`}
        </button>
      )}
    </div>
  );
}

/** Changes the Revert button is offered for; the server decides for certain when it works out the request. */
const revertable = (c: CfChange) => c.result !== 'failure' && ['create', 'update', 'delete'].includes(c.actionType) && c.category !== 'onboarding';

function ChangeRow({ c, show, indent = 'pl-14', history, onLookup, looking, onRevert }: {
  c: CfChange; show: { zone?: boolean; category?: boolean }; indent?: string;
  history?: CfHistoryResult; onLookup: (c: CfChange) => void; looking: boolean; onRevert?: (c: CfChange) => void;
}) {
  const needsOld = c.oldSource === 'lookup' && (c.actionType === 'update' || c.actionType === 'delete');
  return (
    <li className={cx('grid grid-cols-[minmax(0,1fr)] gap-1 border-t border-line/30 py-3 pr-5 text-[13px] first:border-0 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-3', indent)}>
      <time className="font-mono text-[11.5px] text-muted tabular-nums" dateTime={c.time} title={fmtDate(c.time)}>
        {new Date(c.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} {timeLabel(c.time)}
      </time>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 break-words font-medium text-ink">
          {changeTitle(c)}
          {c.result === 'failure' && <Badge tone="bad">failed</Badge>}
          {c.actionType === 'delete' && c.result !== 'failure' && <span className="text-xs font-normal text-bad">deleted by {actorLabel(c)}</span>}
          {show.category && <Badge tone={CATEGORY_TONE[c.category] ?? 'neutral'}>{CATEGORY_LABEL[c.category]}</Badge>}
        </p>
        <p className="mt-0.5 text-xs break-words text-muted">
          <span className="text-ink-2">{c.accountName || c.accountId}</span>{' › '}<span className="text-ink-2">{zoneLabel(c)}</span>
          {' · '}{actorLabel(c)}{c.actorContext && ` via ${contextLabel(c.actorContext)}`}{c.actorIp && ` · ${c.actorIp}`}
          {c.officialCategory && <> · Cloudflare category: {c.officialCategory}</>}
        </p>
        {c.result === 'failure' && (
          <p className="mt-1.5 text-xs text-bad">Cloudflare rejected this change{c.status ? ` (HTTP ${c.status})` : ''}: nothing was changed. The values below are what was attempted.</p>
        )}
        <FieldTable c={c} history={history} />
        {c.oldNote && !history && <p className="mt-1.5 text-xs text-muted">Old values from {c.oldNote}.</p>}
        {((needsOld && !history) || (onRevert && revertable(c))) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {needsOld && !history && <Button size="sm" icon={<HistoryIcon className="size-3.5" />} loading={looking} onClick={() => onLookup(c)}>Look up old values</Button>}
            {onRevert && revertable(c) && <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />} onClick={() => onRevert(c)}>Revert</Button>}
          </div>
        )}
        {history && (
          <p className="mt-1.5 text-xs text-muted">
            {history.previousTime
              ? <>Old values from Cloudflare Resource History{history.historyStatus === 'approximate' ? ' (approximate match)' : ''}: previous change {fmtDate(history.previousTime)}{history.previousActor ? ` by ${history.previousActor}` : ''}.</>
              : 'Cloudflare Resource History has no earlier state for this resource.'}
          </p>
        )}
        {(c.uri || c.description) && (
          <p className="mt-1 font-mono text-[11px] break-all text-faint">{c.method} {c.uri}{c.status ? ` → ${c.status}` : ''}{c.description ? ` · ${c.description}` : ''}</p>
        )}
      </div>
    </li>
  );
}

function ZoneOnboarding({ events, accountsWithoutList }: { events: CfZoneEvent[]; accountsWithoutList: string[] }) {
  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
        <h2 className="text-[15px] font-semibold">Zone onboarding</h2>
        <span className="flex gap-1.5">
          {(['added', 'activated', 'removed'] as const).map((k) => {
            const n = events.filter((e) => e.event === k).length;
            return n ? <Badge key={k} tone={EVENT_TONE[k]}>{n} {EVENT_LABEL[k].toLowerCase()}</Badge> : null;
          })}
        </span>
      </div>
      {events.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="text-muted">
              <tr className="border-b border-line">
                {['Zone', 'Account', 'What happened', 'When', 'Status now', 'Plan / type', 'By'].map((h) => <th key={h} className="px-5 py-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={`${e.zoneId}-${e.event}-${e.time}`} className="border-b border-line/60 last:border-0">
                  <td className="px-5 py-2.5 font-medium">{e.zoneName}</td>
                  <td className="px-5 py-2.5 text-ink-2">{e.accountName || e.accountId}</td>
                  <td className="px-5 py-2.5"><Badge tone={EVENT_TONE[e.event]}>{EVENT_LABEL[e.event]}</Badge></td>
                  <td className="px-5 py-2.5 whitespace-nowrap text-ink-2" title={e.time}>{fmtDate(e.time)}</td>
                  <td className="px-5 py-2.5 text-ink-2">{e.status || '—'}</td>
                  <td className="px-5 py-2.5 text-ink-2">{[e.plan, e.type].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="px-5 py-2.5 text-ink-2">{e.actor || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-5 py-4 text-[13px] text-muted">No zones were added, activated or removed in this period.</p>
      )}
      {accountsWithoutList.length > 0 && (
        <p className="border-t border-line px-5 py-2.5 text-xs text-warn">
          Zone list not readable for {accountsWithoutList.join(', ')} (the token needs “Zone: Read”). Additions there are taken from the audit log only.
        </p>
      )}
    </Card>
  );
}

export default function CloudflareActivityPage() {
  const toast = useToast();
  const { can } = useMe();
  const allowed = can('audit:read');
  const canRevert = can('cloudflare:revert');
  const [reverting, setReverting] = useState<CfChange | null>(null);
  const [creds, setCreds] = useState<CredentialOption[] | null>(null);
  // One Cloudflare account ('' = all of them), not a stored credential: a token can reach several accounts.
  const [accountId, setAccountId] = useState('');
  const [knownAccounts, setKnownAccounts] = useState<Record<string, string>>({});
  const learnAccounts = useCallback((list: { id: string; name: string }[]) => setKnownAccounts((m) => {
    const next = { ...m };
    let changed = false;
    for (const a of list) if (a.id && (!(a.id in next) || (!next[a.id] && a.name))) { next[a.id] = a.name; changed = true; }
    return changed ? next : m;
  }), []);
  const [range, setRange] = useState<CfRange>('week');
  const today = isoDay(new Date());
  const [custom, setCustom] = useState({ since: isoDay(new Date(Date.now() - 14 * 86_400_000)), before: today });
  const [applied, setApplied] = useState(custom);
  const [report, setReport] = useState<CfAuditReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<View>('category');
  const [category, setCategory] = useState<CategoryKey | ''>('');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(TIMELINE_PAGE);
  const [history, setHistory] = useState<Record<string, CfHistoryResult>>({});
  const [looking, setLooking] = useState('');

  useEffect(() => {
    if (!allowed) return;
    api<{ options: CredentialOption[] }>('/api/credentials/options')
      .then((r) => setCreds(r.options.filter((o) => o.kind === 'cloudflare')))
      .catch((e) => { setCreds([]); toast((e as Error).message, 'bad'); });
  }, [allowed, toast]);
  // The accounts, from the zone list every page shares (usually loaded already, so the menu fills at once).
  useEffect(() => {
    if (!allowed) return;
    zoneList().then((l) => learnAccounts(l.zones.map((z) => ({ id: z.accountId, name: z.accountName })))).catch(() => { /* the report below lists them too */ });
  }, [allowed, learnAccounts]);
  const accountOptions = useMemo(() => Object.entries(knownAccounts).map(([id, name]) => ({ id, name: name || id })).sort((a, b) => a.name.localeCompare(b.name)), [knownAccounts]);

  const query0 = useMemo(() => new URLSearchParams({ credentialId: 'all', range, ...(accountId ? { accountId } : {}), ...(range === 'custom' ? applied : {}) }), [accountId, range, applied]);
  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError('');
    try {
      const rep = await api<CfAuditReport>(`/api/cloudflare-audit?${query0}${fresh ? '&fresh=1' : ''}`);
      // Every account the report read (also ones without zones) joins the menu.
      learnAccounts(rep.accounts.filter((a) => a.accountId).map((a) => ({ id: a.accountId, name: a.accountName })));
      setReport(rep);
      setHistory({});
      setShown(TIMELINE_PAGE);
    } catch (e) {
      setReport(null);
      setError((e as Error).message);
    } finally { setLoading(false); }
  }, [query0, learnAccounts]);
  useEffect(() => { if (allowed && creds?.length) load(); }, [load, allowed, creds]);

  const lookup = useCallback(async (c: CfChange) => {
    setLooking(c.id);
    try {
      const q = new URLSearchParams({ accountId: c.accountId, id: c.id, time: c.time });
      const h = await api<CfHistoryResult>(`/api/cloudflare-audit/history?${q}`);
      setHistory((cur) => ({ ...cur, [c.id]: h }));
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setLooking(''); }
  }, [toast]);

  const searched = useMemo(() => filterChanges(report?.changes ?? [], query), [report, query]);
  const filtered = useMemo(() => filterChanges(searched, '', category), [searched, category]);
  const categoryCounts = useMemo(() => {
    const m = new Map<CategoryKey, number>();
    for (const c of searched) m.set(c.category, (m.get(c.category) ?? 0) + 1);
    return m;
  }, [searched]);
  const t = useMemo(() => totals(filtered), [filtered]);
  const groups = useMemo(() => byCategory(filtered), [filtered]);
  const accounts = useMemo(() => (view === 'zone' ? byAccount(filtered) : []), [filtered, view]);

  if (!allowed) {
    return <Card className="rise mx-auto mt-6 max-w-lg"><EmptyState icon={<Lock className="size-5" />} title="Admins only" description="Cloudflare activity is visible to admins and super admins." /></Card>;
  }

  const download = async () => {
    if (!report) return;
    const q = new URLSearchParams(query0);
    if (query.trim()) q.set('q', query.trim());
    if (category) q.set('category', category);
    try {
      const res = await fetch(`/api/cloudflare-audit/export.csv?${q}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `cloudflare-changes-${report.since.slice(0, 10)}-to-${report.before.slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const row = (c: CfChange, show: { zone?: boolean; category?: boolean }, indent: string) => (
    <ChangeRow key={c.id} c={c} show={show} indent={indent} history={history[c.id]} onLookup={lookup} looking={looking === c.id} onRevert={canRevert ? setReverting : undefined} />
  );
  const problems = report?.accounts.filter((a) => a.error || a.truncated) ?? [];
  const ignored = report?.accounts.reduce((n, a) => n + (a.ignored ?? 0), 0) ?? 0;
  const noZoneList = report?.accounts.filter((a) => a.zonesError && !a.error).map((a) => a.accountName || a.credentialName) ?? [];
  const onboarded = report?.zoneEvents.filter((e) => e.event !== 'removed').length ?? 0;
  const removed = report?.zoneEvents.filter((e) => e.event === 'removed').length ?? 0;
  const timelineDays: { day: string; items: CfChange[] }[] = [];
  for (const c of filtered.slice(0, shown)) {
    const d = dayLabel(c.time);
    if (timelineDays[timelineDays.length - 1]?.day !== d) timelineDays.push({ day: d, items: [] });
    timelineDays[timelineDays.length - 1].items.push(c);
  }

  return (
    <div className="rise">
      <PageHeader
        eyebrow="Cloudflare"
        title="Cloudflare activity"
        description="What changed in your Cloudflare accounts — by category, account and zone, with old and new values — from Cloudflare's own audit log."
        actions={(
          <div className="flex flex-wrap gap-2">
            <Button icon={<RefreshCw className={cx('size-4', loading && 'animate-spin')} />} onClick={() => load(true)} disabled={loading || !creds?.length}>Refresh</Button>
            <Button icon={<Copy className="size-4" />} disabled={!report} onClick={async () => { if (report) { await copyText(summaryText({ ...report, changes: filtered })); toast('Summary copied as text'); } }}>Copy summary</Button>
            <Button icon={<Download className="size-4" />} disabled={!report || !filtered.length} onClick={download}>CSV</Button>
          </div>
        )}
      />

      {creds && !creds.length ? (
        <Card><EmptyState icon={<Cloud className="size-5" />} title="No Cloudflare credentials yet"
          description="A super admin adds Cloudflare API tokens under Credentials. Tokens need “Account Settings: Read” for audit logs and “Zone: Read” for onboarding." /></Card>
      ) : (
        <>
          <Card className="mb-4 space-y-3 px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-[13px] text-muted" htmlFor="cf-cred">Account</label>
              <select id="cf-cred" className="input !w-auto min-w-[260px]" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">All Cloudflare accounts{accountOptions.length ? ` (${accountOptions.length})` : ''}</option>
                {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.id.slice(0, 8)}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Period">
              {CF_RANGES.map((r) => <Chip key={r.value} active={range === r.value} onClick={() => setRange(r.value)}>{r.label}</Chip>)}
            </div>
            {range === 'custom' && (
              <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setApplied({ ...custom }); }}>
                <label className="grid gap-1 text-xs text-muted">From
                  <input type="date" className="input !w-auto" value={custom.since} max={custom.before} onChange={(e) => setCustom({ ...custom, since: e.target.value })} required />
                </label>
                <label className="grid gap-1 text-xs text-muted">To (inclusive)
                  <input type="date" className="input !w-auto" value={custom.before} min={custom.since} max={today} onChange={(e) => setCustom({ ...custom, before: e.target.value })} required />
                </label>
                <Button type="submit" variant="primary" disabled={loading}>Apply</Button>
                <span className="text-xs text-faint">Cloudflare keeps 18 months of audit logs. Dates are UTC.</span>
              </form>
            )}
          </Card>

          {report?.cachedIn && report.readAt && <p className="mb-3 text-xs text-faint">Read from Cloudflare at {fmtDate(report.readAt)} · from the cache{report.cachedIn === 'redis' ? ' (Redis)' : ''} — Refresh for live data.</p>}
          {error && <div className="mb-4"><Alert tone="bad" title="Could not load Cloudflare activity">{error}</Alert></div>}
          {problems.map((a) => (
            <div key={a.accountId} className="mb-4">
              <Alert tone={a.error ? 'bad' : 'warn'} title={a.accountName || a.credentialName}>
                {a.error ?? `Only the newest ${a.count.toLocaleString()} changes were read. Choose a shorter period to see everything.`}
              </Alert>
            </div>
          ))}

          {!report && !error ? (
            <Loading label="Loading Cloudflare activity stats" className="mb-6"><SkeletonStats className="sm:!gap-4 md:!grid-cols-2 lg:!grid-cols-4" /></Loading>
          ) : <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <Stat label="Changes" value={report ? t.total.toLocaleString() : '—'} sub={report ? `${t.create} created · ${t.update} updated · ${t.delete} deleted` : loading ? 'Loading…' : ' '} />
            <Stat label="Zones changed" value={report ? t.zones : '—'} sub={report ? `in ${t.accounts} account${t.accounts === 1 ? '' : 's'}` : ' '} />
            <Stat label="Categories" value={report ? t.categories : '—'} sub={groups[0] ? `${groups.map((x) => x.label).slice(0, 2).join(', ')}${groups.length > 2 ? '…' : ''}` : report ? 'nothing changed' : ' '} />
            <Stat label="Zones onboarded" value={report ? onboarded : '—'} sub={report ? (removed ? `${removed} removed` : 'none removed') : ' '} tone={onboarded ? 'ok' : undefined} />
          </div>}

          {report && <ZoneOnboarding events={report.zoneEvents} accountsWithoutList={noZoneList} />}

          <Card>
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-5 py-3" role="group" aria-label="Category">
              <Chip active={category === ''} onClick={() => setCategory('')}>All {report || error ? <span className="tabular-nums text-faint">{searched.length}</span> : <Skeleton className="!inline-block h-2.5 w-3 align-middle" />}</Chip>
              {CATEGORIES.filter((c) => categoryCounts.get(c.key)).map((c) => (
                <Chip key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
                  <span title={c.description}>{c.label}</span> <span className="tabular-nums text-faint">{categoryCounts.get(c.key)}</span>
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="View">
                {VIEWS.map((v) => <Chip key={v.value} active={view === v.value} onClick={() => setView(v.value)}>{v.label}</Chip>)}
              </div>
              <label className="relative ml-auto w-full sm:w-72">
                <span className="sr-only">Filter changes</span>
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
                <input className="input !pl-9" placeholder="Filter: zone, field, value, person…" value={query} onChange={(e) => { setQuery(e.target.value); setShown(TIMELINE_PAGE); }} />
              </label>
            </div>

            {!report && error ? (
              <p className="px-5 py-6 text-[13px] text-muted">Nothing to show.</p>
            ) : !report ? (
              <Loading label="Reading Cloudflare audit logs">
                {[40, 28, 52, 34, 46].map((w, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-line/60 px-5 py-3.5 last:border-0">
                    <Skeleton className="size-4 shrink-0" />
                    <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
                    <Skeleton className="hidden h-3 w-24 sm:block" />
                    <span className="ml-auto flex gap-2"><Skeleton className="h-5 w-10" /><Skeleton className="h-5 w-8" /></span>
                  </div>
                ))}
              </Loading>
            ) :  !filtered.length ? (
              <EmptyState icon={<Cloud className="size-5" />} title={query || category ? 'No changes match' : 'No changes in this period'}
                description={query || category ? 'Try another category, zone or value.' : 'Cloudflare recorded no changes for the selected accounts.'} />
            ) : view === 'category' ? (
              <div>
                {groups.map((g) => (
                  <Group key={g.category} title={g.label} sub={`${g.scopes.length} account/zone scope${g.scopes.length === 1 ? '' : 's'}`} tally={g.tally} defaultOpen={groups.length <= 2}>
                    {g.scopes.map((s) => (
                      <Group key={s.key} level={1} title={s.zone} sub={s.account} tally={s.tally} defaultOpen={g.scopes.length === 1 && s.changes.length <= 10}>
                        <ul>{s.changes.map((c) => row(c, {}, 'pl-9 sm:pl-14'))}</ul>
                      </Group>
                    ))}
                  </Group>
                ))}
              </div>
            ) : view === 'zone' ? (
              <div>
                {accounts.map((a) => (
                  <Group key={a.accountId} title={a.accountName} sub={<span className="font-mono">{a.accountId}</span>} tally={a.tally} defaultOpen>
                    {a.zones.map((z) => (
                      <Group key={z.zoneId || '-'} level={1} title={z.label} sub={`${z.categories.length} categor${z.categories.length === 1 ? 'y' : 'ies'}`} tally={z.tally} defaultOpen={a.zones.length <= 3}>
                        {z.categories.map((f) => (
                          <Group key={f.category} level={2} title={f.label} tally={f.tally}>
                            <ul>{f.changes.map((c) => row(c, {}, 'pl-9 sm:pl-[4.5rem]'))}</ul>
                          </Group>
                        ))}
                      </Group>
                    ))}
                  </Group>
                ))}
              </div>
            ) : (
              <div>
                {timelineDays.map((d) => (
                  <section key={d.day} className="border-t border-line/60 first:border-0">
                    <h2 className="eyebrow px-5 pt-4 pb-1">{d.day}</h2>
                    <ul>{d.items.map((c) => row(c, { category: true }, 'pl-5'))}</ul>
                  </section>
                ))}
                {shown < filtered.length && (
                  <div className="flex justify-center border-t border-line p-3">
                    <Button size="sm" onClick={() => setShown(shown + TIMELINE_PAGE)}>Show {Math.min(TIMELINE_PAGE, filtered.length - shown)} more of {(filtered.length - shown).toLocaleString()}</Button>
                  </div>
                )}
              </div>
            )}
          </Card>
          {reverting && <RevertModal change={reverting} onClose={() => setReverting(null)} onDone={() => { setReverting(null); load(); }} />}
          {report && (
            <p className="mt-3 text-xs text-faint">
              Period: {periodText(report)} · Old values come from the previous change to the same resource, or from Cloudflare Resource History (deletes: looked up automatically, then the newest backup that has the object). Only creates, updates and deletes are shown: views, reads (backup runs, lookups) and failed requests are filtered out by Cloudflare{ignored > 0 ? `, and ${ignored} other entr${ignored === 1 ? 'y' : 'ies'} (cache purges, exports) ${ignored === 1 ? 'was' : 'were'} left out` : ''}. Secret-looking fields are masked.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Reviews and sends one revert. The server works out the request (shown here exactly as it will be
 * sent) with the stored read-only token; sending needs the account's Global API Key, used once.
 */
function RevertModal({ change: c, onClose, onDone }: { change: CfChange; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [plan, setPlan] = useState<CfRevertPlan | null>(null);
  const [refusal, setRefusal] = useState('');
  const [f, setF] = useState({ email: '', apiKey: '', ack: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ plan: CfRevertPlan }>('/api/cloudflare-audit/revert/plan', { method: 'POST', json: { accountId: c.accountId, entryId: c.id, time: c.time } })
      .then((r) => setPlan(r.plan))
      .catch((e) => setRefusal((e as Error).message));
  }, [c]);

  const send = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await api('/api/cloudflare-audit/revert', { method: 'POST', json: { accountId: c.accountId, entryId: c.id, time: c.time, planHash: plan.planHash, email: f.email, apiKey: f.apiKey, acknowledgeChangedSince: f.ack } });
      toast(`Reverted: ${plan.summary}`, 'ok');
      onDone();
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} width="max-w-2xl" title="Revert this Cloudflare change?" description={`${changeTitle(c)} · ${zoneLabel(c)} · ${actorLabel(c)}, ${fmtDate(c.time)}`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {plan && (
          <Button variant="danger" icon={<Undo2 className="size-4" />} loading={busy} onClick={send}
            disabled={!f.email.trim() || f.apiKey.trim().length < 30 || (plan.changedSince && !f.ack)}>Send to Cloudflare</Button>
        )}
      </>}>
      {!plan && !refusal && <p className="text-[13px] text-muted">Working out the request from Cloudflare Resource History…</p>}
      {refusal && <Alert tone="warn" title="This change can't be reverted automatically">{refusal}</Alert>}
      {plan && (
        <div className="space-y-4 text-[13px]">
          <p className="font-medium text-ink">{plan.summary}</p>
          <div>
            <p className="eyebrow mb-1.5">Request that will be sent</p>
            <div className="overflow-hidden rounded-lg border border-line">
              <p className="border-b border-line bg-raised/50 px-3 py-1.5 font-mono text-[12px] break-all"><span className="font-semibold text-ink">{plan.method}</span> {plan.path}</p>
              {plan.body !== null && <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-[11.5px] break-all whitespace-pre-wrap text-ink-2">{JSON.stringify(plan.body, null, 2)}</pre>}
            </div>
          </div>
          {plan.notes.map((n) => <p key={n} className="text-xs text-muted">{n}.</p>)}
          {plan.changedSince && (
            <Alert tone="warn" title="Changed again since">
              <span className="block">It was changed again after this entry. Reverting also undoes those later changes.</span>
              <label className="mt-2 flex items-center gap-2 text-ink-2">
                <input type="checkbox" checked={f.ack} onChange={(e) => setF({ ...f, ack: e.target.checked })} /> Revert anyway
              </label>
            </Alert>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cloudflare account email" htmlFor="rv-email">
              <input id="rv-email" type="email" autoComplete="off" className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </Field>
            <Field label="Global API Key" htmlFor="rv-key" hint="Used for this request only — never stored.">
              <input id="rv-key" type="password" autoComplete="off" className="input" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  );
}
