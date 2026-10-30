'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BarChart3, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import type { StatusClass, TrafficCountry, TrafficDay, TrafficPending, TrafficReport, TrafficSlice, TrafficTotals, TrafficZone } from '@/lib/traffic-types';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, SectionHeader, Stat, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import type { ZoneListItem } from '@/lib/zone-catalog';
import { zoneList as loadZoneList } from '@/lib/zone-list-client';
import { bytes, dayLabel, num, pct, whole } from './format';
import { DetailHost, ZoneDetailView, useOpenDetail, type Target } from './zone-detail';

// ── Formatting ──────────────────────────────────────────────────────────────

const perDay = (t: TrafficTotals) => (t.days ? Math.round(t.uniquesSum / t.days) : 0);
const monthName = (m: string, style: 'long' | 'short' = 'long') => new Date(`${m}-01T00:00:00Z`).toLocaleString(undefined, { month: style, year: style === 'long' ? 'numeric' : undefined, timeZone: 'UTC' });
const prevMonth = (m: string) => { const d = new Date(`${m}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

/** The last twelve months, this one first (UTC, like the API). */
function lastMonths() {
  const now = new Date();
  return Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
}

/** "+12.3% vs Sep" — traffic going up is neither good nor bad, so it stays neutral. */
function Change({ now, before, month, short }: { now: number; before: number | undefined | null; month: string; short?: boolean }) {
  if (before === undefined || before === null) return null;
  if (!before && !now) return <span className="text-faint">—</span>;
  if (!before) return <span className="text-faint">{short ? 'new' : `nothing in ${monthName(prevMonth(month), 'short')}`}</span>;
  const d = ((now - before) / before) * 100;
  const s = `${d > 0 ? '+' : ''}${Math.abs(d) < 0.05 ? '0' : d.toFixed(1)}%`;
  return <span className="tabular-nums text-ink-2">{d > 0 ? '▲' : d < 0 ? '▼' : '•'} {s}{short ? '' : ` vs ${monthName(prevMonth(month), 'short')}`}</span>;
}

// ── Pieces ──────────────────────────────────────────────────────────────────

/** A stat card that opens the details window behind it. */
function OpenCard({ label, onOpen, children }: { label: string; onOpen?: () => void; children: ReactNode }) {
  if (!onOpen) return <>{children}</>;
  return (
    <button type="button" onClick={onOpen} aria-label={`${label}: open the details`} title="Open the details"
      className="rounded-[var(--radius-card)] text-left transition-shadow hover:ring-1 hover:ring-signal/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      {children}
    </button>
  );
}

function Totals({ s, month, partial, target }: { s: TrafficSlice; month: string; partial: boolean; target?: Target }) {
  const t = s.totals, p = s.previous;
  const vs = partial ? ' (same days)' : '';
  const open = useOpenDetail();
  const go = (label: string, focus: 'security' | 'requests') => (target ? () => open({ t: target, focus, label }) : undefined);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <OpenCard label="Requests" onOpen={go('Requests', 'requests')}><Stat label="Requests" value={num(t.requests)} sub={<Change now={t.requests} before={p?.requests} month={month} />} /></OpenCard>
      <OpenCard label="Bandwidth" onOpen={go('Bandwidth', 'requests')}><Stat label="Bandwidth" value={bytes(t.bytes)} sub={<Change now={t.bytes} before={p?.bytes} month={month} />} /></OpenCard>
      <OpenCard label="Served from cache" onOpen={go('Cache', 'requests')}><Stat label="Served from cache" value={pct(t.cachedRequests, t.requests)} sub={<span>{pct(t.cachedBytes, t.bytes)} of bandwidth</span>} /></OpenCard>
      <OpenCard label="Threats" onOpen={go('Threats', 'security')}><Stat label="Threats" value={num(t.threats)} sub={<Change now={t.threats} before={p?.threats} month={month} />} /></OpenCard>
      <OpenCard label="Page views" onOpen={go('Page views', 'requests')}><Stat label="Page views" value={num(t.pageViews)} sub={<Change now={t.pageViews} before={p?.pageViews} month={month} />} /></OpenCard>
      <OpenCard label="Visitors" onOpen={go('Visitors', 'requests')}><Stat label="Visitors / day" value={num(perDay(t))} sub={<span title={`Average of the daily unique visitors${vs}`}>daily average</span>} /></OpenCard>
    </div>
  );
}

/** Every day of the range, with zero for days without traffic. */
function fillDays(daily: TrafficDay[], since: string, until: string): TrafficDay[] {
  const by = new Map(daily.map((d) => [d.date, d]));
  const out: TrafficDay[] = [];
  for (let t = Date.parse(`${since}T00:00:00Z`); t < Date.parse(`${until}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push(by.get(date) ?? { date, requests: 0, cachedRequests: 0, bytes: 0, cachedBytes: 0, threats: 0, pageViews: 0, uniques: 0 });
  }
  return out;
}

/** Requests per day: served from cache (orange) on top of those that went to the origin (grey). */
function DailyChart({ daily, since, until, target }: { daily: TrafficDay[]; since: string; until: string; target?: Target }) {
  const days = useMemo(() => fillDays(daily, since, until), [daily, since, until]);
  const open = useOpenDetail();
  const max = Math.max(1, ...days.map((d) => d.requests));
  const [hover, setHover] = useState<number | null>(null);
  const h = hover !== null ? days[hover] : null;
  if (!days.length) return null;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="font-medium text-ink-2">Requests per day</span>{target && <span className="text-faint">click a bar for that day&apos;s detail</span>}
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-signal" />From cache</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-faint" />From origin</span>
      </div>
      <div className="relative">
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line" />
        <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-line/60" />
        <span className="pointer-events-none absolute top-0 right-0 -translate-y-full pb-0.5 text-[10.5px] text-faint tabular-nums">{num(max)}</span>
        <div className="flex h-40 items-end gap-[2px] border-b border-line-strong pt-1" onMouseLeave={() => setHover(null)}>
          {days.map((d, i) => {
            const origin = Math.max(0, d.requests - d.cachedRequests);
            return (
              <button key={d.date} type="button" aria-label={`${dayLabel(d.date)}: ${whole.format(d.requests)} requests`}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                onClick={() => target && open({ t: target, filter: { day: d.date }, label: 'All traffic' })}
                className={cx('flex h-full min-w-0 flex-1 flex-col justify-end rounded-t-[4px] focus:outline-none', hover === i && 'bg-raised/60', target && 'cursor-pointer')}>
                <span className="flex w-full flex-col gap-[2px] overflow-hidden rounded-t-[4px]" style={{ height: `${(d.requests / max) * 100}%` }}>
                  {d.cachedRequests > 0 && <span className="w-full bg-signal" style={{ flexGrow: d.cachedRequests }} />}
                  {origin > 0 && <span className="w-full bg-faint" style={{ flexGrow: origin }} />}
                </span>
              </button>
            );
          })}
        </div>
        {h && hover !== null && (
          <div className="pointer-events-none absolute bottom-full z-20 mb-2 w-52 rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs shadow-pop"
            style={{ left: `${((hover + 0.5) / days.length) * 100}%`, transform: `translateX(${hover < days.length / 3 ? '-10%' : hover > (days.length * 2) / 3 ? '-90%' : '-50%'})` }}>
            <div className="mb-1 font-medium text-ink">{dayLabel(h.date)}</div>
            <Row k="Requests" v={whole.format(h.requests)} />
            <Row k="From cache" v={`${whole.format(h.cachedRequests)} (${pct(h.cachedRequests, h.requests)})`} />
            <Row k="Bandwidth" v={bytes(h.bytes)} />
            <Row k="Threats" v={whole.format(h.threats)} />
            <Row k="Visitors" v={whole.format(h.uniques)} />
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-faint">
        <span>{dayLabel(days[0].date)}</span>
        {days.length > 2 && <span>{dayLabel(days[Math.floor(days.length / 2)].date)}</span>}
        <span>{dayLabel(days[days.length - 1].date)}</span>
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted hover:text-ink">Daily numbers</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-line">
          <table className="w-full text-left text-[12px] tabular-nums">
            <thead className="sticky top-0 bg-raised text-muted"><tr>{['Day', 'Requests', 'From cache', 'Bandwidth', 'Threats', 'Page views', 'Visitors'].map((x) => <th key={x} className="px-3 py-1.5 font-medium">{x}</th>)}</tr></thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date} className="border-t border-line/50">
                  <td className="px-3 py-1">{dayLabel(d.date)}</td><td className="px-3 py-1">{whole.format(d.requests)}</td><td className="px-3 py-1">{pct(d.cachedRequests, d.requests)}</td>
                  <td className="px-3 py-1">{bytes(d.bytes)}</td><td className="px-3 py-1">{whole.format(d.threats)}</td><td className="px-3 py-1">{whole.format(d.pageViews)}</td><td className="px-3 py-1">{whole.format(d.uniques)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => <div className="flex justify-between gap-3 text-ink-2"><span className="text-muted">{k}</span><span className="tabular-nums">{v}</span></div>;

const STATUS: { k: StatusClass; label: string; cls: string }[] = [
  { k: '2xx', label: '2xx success', cls: 'bg-ok' },
  { k: '3xx', label: '3xx redirect', cls: 'bg-info' },
  { k: '4xx', label: '4xx client error', cls: 'bg-warn' },
  { k: '5xx', label: '5xx server error', cls: 'bg-bad' },
  { k: '1xx', label: '1xx informational', cls: 'bg-faint' },
];

function Statuses({ s }: { s: Record<StatusClass, number> | null }) {
  if (!s) return <p className="text-xs text-muted">No status-code breakdown for this month.</p>;
  const total = STATUS.reduce((n, x) => n + s[x.k], 0);
  if (!total) return <p className="text-xs text-muted">No requests.</p>;
  return (
    <div>
      <div className="flex h-3 gap-[2px] overflow-hidden rounded" role="img" aria-label={STATUS.map((x) => `${x.label} ${pct(s[x.k], total)}`).join(', ')}>
        {STATUS.filter((x) => s[x.k] > 0).map((x) => <span key={x.k} className={x.cls} style={{ flexGrow: s[x.k] }} title={`${x.label}: ${whole.format(s[x.k])}`} />)}
      </div>
      <ul className="mt-3 space-y-1 text-xs">
        {STATUS.filter((x) => s[x.k] > 0 || x.k !== '1xx').map((x) => (
          <li key={x.k} className="flex items-center gap-2">
            <span className={cx('size-2.5 shrink-0 rounded-sm', x.cls)} />
            <span className="flex-1 text-ink-2">{x.label}</span>
            <span className="tabular-nums text-muted">{num(s[x.k])}</span>
            <span className="w-14 text-right tabular-nums text-ink-2">{pct(s[x.k], total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Countries({ list, total }: { list: TrafficCountry[]; total: number }) {
  if (!list.length) return <p className="text-xs text-muted">No country breakdown for this month.</p>;
  return (
    <table className="w-full text-left text-xs tabular-nums">
      <thead className="text-muted"><tr><th className="pb-1 font-medium">Country</th><th className="pb-1 font-medium">Requests</th><th className="pb-1 text-right font-medium">Bandwidth</th><th className="pb-1 text-right font-medium">Threats</th></tr></thead>
      <tbody>
        {list.map((c) => (
          <tr key={c.country} className="border-t border-line/50">
            <td className="py-1 pr-2 text-ink-2">{c.country}</td>
            <td className="py-1 pr-2">
              <div className="flex items-center gap-2">
                <span className="h-1.5 w-16 overflow-hidden rounded-full bg-raised"><span className="block h-full rounded-full bg-signal" style={{ width: `${total ? (c.requests / total) * 100 : 0}%` }} /></span>
                <span className="text-ink-2">{num(c.requests)}</span>
              </div>
            </td>
            <td className="py-1 text-right text-muted">{bytes(c.bytes)}</td>
            <td className="py-1 text-right text-muted">{num(c.threats)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Totals, the daily chart, status codes and countries of one slice. */
function SliceBody({ s, r, totals = true, target }: { s: TrafficSlice; r: TrafficReport; totals?: boolean; target?: Target }) {
  return (
    <div className="space-y-5">
      {totals && <Totals s={s} month={r.month} partial={r.partial} target={target} />}
      <DailyChart daily={s.daily} since={r.since} until={r.until} target={target} />
      <div className="grid gap-5 lg:grid-cols-2">
        <div><div className="eyebrow mb-2">Status codes</div><Statuses s={s.statuses} /></div>
        <div><div className="eyebrow mb-2">Top countries</div><Countries list={s.countries} total={s.totals.requests} /></div>
      </div>
    </div>
  );
}


function ZoneTable({ zones, r }: { zones: TrafficZone[]; r: TrafficReport }) {
  const [open, setOpen] = useState<string | null>(null);
  const head = ['Zone', 'Requests', 'Change', 'Bandwidth', 'From cache', 'Threats', 'Visitors / day'];
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[720px] text-left text-[12.5px]">
        <thead className="bg-raised/50 text-muted"><tr>{head.map((x, i) => <th key={x} className={cx('px-3 py-2 font-medium whitespace-nowrap', i > 0 && 'text-right')}>{x}</th>)}</tr></thead>
        <tbody className="tabular-nums">
          {zones.map((z) => {
            const ok = z.status === 'ok';
            const expanded = open === z.id;
            return (
              <Fragment key={z.id}>
                <tr className={cx('border-t border-line/50', ok && 'cursor-pointer hover:bg-raised/40', expanded && 'bg-raised/40')}
                  onClick={() => ok && setOpen(expanded ? null : z.id)}>
                  <td className="px-3 py-2">
                    <button type="button" disabled={!ok} aria-expanded={expanded} className="flex items-center gap-1.5 text-left disabled:cursor-default" onClick={(e) => { e.stopPropagation(); if (ok) setOpen(expanded ? null : z.id); }}>
                      <ChevronRight className={cx('size-3.5 shrink-0 text-faint transition-transform', expanded && 'rotate-90', !ok && 'invisible')} aria-hidden />
                      <span>
                        <span className="block font-medium text-ink">{z.name}</span>
                        <span className="block text-[11px] text-faint">{z.plan}</span>
                      </span>
                    </button>
                  </td>
                  {ok ? (
                    <>
                      <td className="px-3 py-2 text-right text-ink">{num(z.totals.requests)}</td>
                      <td className="px-3 py-2 text-right text-xs"><Change now={z.totals.requests} before={z.previous?.requests} month={r.month} short /></td>
                      <td className="px-3 py-2 text-right text-ink-2">{bytes(z.totals.bytes)}</td>
                      <td className="px-3 py-2 text-right text-ink-2">{pct(z.totals.cachedRequests, z.totals.requests)}</td>
                      <td className="px-3 py-2 text-right text-ink-2">{num(z.totals.threats)}</td>
                      <td className="px-3 py-2 text-right text-ink-2">{num(perDay(z.totals))}</td>
                    </>
                  ) : (
                    <td colSpan={6} className="px-3 py-2 text-right"><span className="flex items-center justify-end gap-2"><Badge tone={z.status === 'unavailable' ? 'warn' : 'bad'} className="shrink-0">{z.status === 'unavailable' ? 'No analytics access' : 'Could not be read'}</Badge>{z.message && <span className="min-w-0 text-left text-xs wrap-break-word text-muted">Cloudflare: {z.message}</span>}</span></td>
                  )}
                </tr>
                {expanded && (
                  <tr className="border-t border-line/50 bg-sunken/40">
                    <td colSpan={7} className="space-y-5 px-4 py-4">
                      <SliceBody s={z} r={r} target={{ month: r.month, account: r.scope.accountId, zone: z.id }} />
                      <ZoneDetailView month={r.month} account={r.scope.accountId} zone={z.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

/** What to read: an account, optionally one zone of it, and a month. */
interface Choice { account: string; zone: string; month: string }
const CHOICE_KEY = 'traffic.choice';
const OLD_WORKER = 'The worker that is running is from before this page was updated and answered in its old format. It restarts with the new version once it is idle (a running backup or an open restore keeps it busy) — or cancel its run in GitHub › Actions › Console worker. Then press Show traffic again.';
const query = (c: Choice) => new URLSearchParams({ month: c.month, account: c.account, ...(c.zone ? { zone: c.zone } : {}) }).toString();
const sameChoice = (a: Choice | null, b: Choice | null) => !!a && !!b && a.account === b.account && a.zone === b.zone && a.month === b.month;

export default function TrafficPage() {
  const toast = useToast();
  const months = useMemo(lastMonths, []);
  // The account and zone lists come from the zone explorer's (cached) zone list: no analytics are read for them.
  const [zoneList, setZoneList] = useState<ZoneListItem[] | null>(null);
  const [listError, setListError] = useState('');
  const [form, setForm] = useState<Choice>({ account: '', zone: '', month: months[0] });
  const [applied, setApplied] = useState<Choice | null>(null);
  const [r, setR] = useState<TrafficReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<TrafficPending | null>(null);

  useEffect(() => {
    // The same zone list as the zone explorer's: already loaded when that page was open.
    loadZoneList().then((x) => {
      setZoneList(x.zones);
      // The last choice is filled in again (not read: that waits for "Show traffic").
      try {
        const last = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null') as Choice | null;
        if (last && x.zones.some((z) => z.accountId === last.account)) {
          setForm({ account: last.account, zone: x.zones.some((z) => z.id === last.zone && z.accountId === last.account) ? last.zone : '', month: months.includes(last.month) ? last.month : months[0] });
        }
      } catch { /* storage blocked */ }
    }).catch((e) => setListError(e instanceof Error ? e.message : String(e)));
  }, [months]);

  const accounts = useMemo(() => {
    const by = new Map<string, { id: string; name: string; zones: number }>();
    for (const z of zoneList ?? []) {
      if (!z.accountId) continue;
      const a = by.get(z.accountId) ?? { id: z.accountId, name: z.accountName || z.accountId, zones: 0 };
      a.zones++;
      by.set(z.accountId, a);
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [zoneList]);
  const zonesOfAccount = useMemo(() => (zoneList ?? []).filter((z) => z.accountId === form.account).sort((a, b) => a.name.localeCompare(b.name)), [zoneList, form.account]);

  // Reading can take a while: the API answers "still reading" (202) and this asks again until it is
  // ready. A newer load (another choice, Refresh) ends the older one's loop.
  const loadSeq = useRef(0);
  // Leaving the page ends the loop (its polls would keep the worker busy for the next page).
  useEffect(() => () => { loadSeq.current++; }, []);
  const load = useCallback(async (c: Choice, fresh = false) => {
    const seq = ++loadSeq.current;
    setApplied(c); setBusy(true); setError(''); setPending(null);
    try { localStorage.setItem(CHOICE_KEY, JSON.stringify(c)); } catch { /* storage blocked */ }
    try {
      for (let first = true; ; first = false) {
        const rep = await api<TrafficReport | TrafficPending>(`/api/traffic?${query(c)}${fresh && first ? '&fresh=1' : ''}`);
        if (seq !== loadSeq.current) return;
        if (!rep || typeof rep !== 'object') throw new Error('The console sent an empty answer');
        if (!('pending' in rep)) {
          // A worker started before this page was updated answers in the old shape (every account at once).
          if (!rep.scope || !Array.isArray(rep.zones) || !Array.isArray(rep.daily)) throw new Error(OLD_WORKER);
          setR(rep); setPending(null);
          if (fresh) toast('Traffic read again from Cloudflare', 'info');
          break;
        }
        setPending(rep);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        if (seq !== loadSeq.current) return;
      }
    } catch (e) {
      if (seq === loadSeq.current) { setError(e instanceof Error ? e.message : String(e)); setPending(null); }
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, [toast]);

  const shown = r && applied && r.month === applied.month && r.scope.accountId === applied.account && (r.scope.zoneId ?? '') === applied.zone ? r : null;
  const lastDay = shown ? new Date(Date.parse(`${shown.until}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : '';
  const formShown = sameChoice(form, applied);
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;
  const zoneName = (id: string) => zoneList?.find((z) => z.id === id)?.name ?? id;

  return (
    <DetailHost>
      <PageHeader eyebrow="Cloudflare" title="Traffic analytics"
        description="Monthly HTTP traffic for one account (all of its zones, then each zone) or one zone. Only what you choose is read from Cloudflare's analytics (UTC days)." />

      <Card className="mb-5">
        <SectionHeader title="What to analyse" description="Choose an account, and a zone if you want just that zone. Nothing is read until you press Show traffic." />
        <form className="grid gap-4 p-5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1fr)_auto] md:items-end"
          onSubmit={(e) => { e.preventDefault(); if (form.account) void load(form); }}>
          <label className="block text-sm">
            <span className="mb-1.5 block text-xs font-medium text-ink-2">Account</span>
            <select id="traffic-account" className="input w-full" value={form.account} disabled={!zoneList}
              onChange={(e) => setForm({ ...form, account: e.target.value, zone: '' })}>
              <option value="">{zoneList ? 'Choose an account…' : 'Loading accounts…'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.zones} zone{a.zones === 1 ? '' : 's'})</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block text-xs font-medium text-ink-2">Zone <span className="font-normal text-faint">(optional)</span></span>
            <select id="traffic-zone" className="input w-full" value={form.zone} disabled={!form.account}
              onChange={(e) => setForm({ ...form, zone: e.target.value })}>
              <option value="">{form.account ? `Whole account (${zonesOfAccount.length} zone${zonesOfAccount.length === 1 ? '' : 's'})` : 'Choose an account first'}</option>
              {zonesOfAccount.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block text-xs font-medium text-ink-2">Month</span>
            <select id="traffic-month" className="input w-full" value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })}>
              {months.map((m, i) => <option key={m} value={m}>{monthName(m)}{i === 0 ? ' (so far)' : ''}</option>)}
            </select>
          </label>
          <Button type="submit" variant="primary" disabled={!form.account || (busy && formShown)} loading={busy && formShown} icon={<BarChart3 className="size-4" />}>Show traffic</Button>
        </form>
        {listError && <div className="px-5 pb-5"><Alert tone="bad" title="Accounts could not be listed">{listError}</Alert></div>}
        {zoneList && !accounts.length && <div className="px-5 pb-5"><EmptyState icon={<BarChart3 className="size-5" />} title="No accounts" description="No stored Cloudflare token can list zones. Add a credential in the vault." /></div>}
      </Card>

      {error && <div className="mb-5"><Alert tone="bad" title="Traffic could not be read">{error}</Alert></div>}

      {applied && busy && (
        <Card className={cx('px-5 text-center text-sm text-muted', shown ? 'mb-5 py-4' : 'py-10')}>
          <RefreshCw className={cx('mx-auto size-5 animate-spin text-faint', shown ? 'mb-2' : 'mb-3')} />
          Reading {applied.zone ? zoneName(applied.zone) : accountName(applied.account)} for {monthName(applied.month)} from Cloudflare{shown ? ' again' : ''}…
          {pending && pending.total > 0 && (
            <div className="mx-auto mt-3 max-w-xs">
              <div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-signal transition-all" style={{ width: `${Math.min(100, (pending.done / pending.total) * 100)}%` }} /></div>
              <div className="mt-1 text-xs tabular-nums text-faint">{pending.done} of {pending.total} parts read</div>
            </div>
          )}
        </Card>
      )}

      {shown && applied && (
        <div className="space-y-5">
          {shown.problems.map((p) => <Alert key={p.credential} tone="warn" title={p.credential}>{p.error}</Alert>)}
          {shown.unavailable > 0 && (
            <Alert tone="warn" title={shown.scope.zoneId ? 'This zone has no analytics here' : `${shown.unavailable} of ${shown.zones.length} zones have no analytics here`}>
              The stored token cannot read analytics. Give it <span className="font-mono">Zone › Analytics › Read</span> in the Cloudflare dashboard.
            </Alert>
          )}
          {shown.detail === 'basic' && <Alert tone="info">Cloudflare did not return the status-code and country breakdown this month; totals and daily numbers are complete.</Alert>}

          <Card>
            <SectionHeader
              title={shown.scope.zoneName ?? shown.scope.accountName}
              description={`${shown.scope.zoneId ? `Zone in ${shown.scope.accountName}` : `Account · ${shown.zones.length} zone${shown.zones.length === 1 ? '' : 's'}`} · ${dayLabel(shown.since)} – ${dayLabel(lastDay)} ${shown.since.slice(0, 4)}${shown.partial ? ' (so far, compared with the same days of last month)' : ''}`}
              aside={(
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => load(applied, true)} disabled={busy} icon={<RefreshCw className="size-3.5" />}>Refresh</Button>
                  <a href={`/api/traffic/export.csv?${query(applied)}`} className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-xs text-ink-2 hover:border-faint hover:text-ink">
                    <Download className="size-3.5" />CSV
                  </a>
                </div>
              )} />
            <div className="p-5">
              {shown.unavailable === shown.zones.length ? (
                <p className="text-sm text-muted">No analytics could be read for {shown.scope.zoneId ? 'this zone' : 'any zone of this account'}.</p>
              ) : <SliceBody s={shown} r={shown} target={{ month: shown.month, account: shown.scope.accountId, zone: shown.scope.zoneId }} />}
              <p className="mt-4 text-[11px] text-faint">Read {fmtDate(shown.generatedAt)}{shown.cachedIn ? ' (cached — Refresh reads again)' : ''}</p>
            </div>
          </Card>

          <ZoneDetailView month={shown.month} account={shown.scope.accountId} zone={shown.scope.zoneId} />

          {!shown.scope.zoneId && shown.zones.length > 0 && (
            <Card>
              <SectionHeader title="Zones" description="Busiest first. Open a zone for its own days, status codes, countries, security events, rules and top IPs." />
              <div className="p-5"><ZoneTable zones={shown.zones} r={shown} /></div>
            </Card>
          )}
        </div>
      )}
    </DetailHost>
  );
}
