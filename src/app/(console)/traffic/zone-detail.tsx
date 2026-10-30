'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Network, RefreshCw, Search, ShieldAlert, X } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { CACHED_STATUSES, MANAGED_RULESETS, MITIGATING_ACTIONS, OWASP_ANOMALY_RULE, OWASP_RULESET, SECURITY_VIEWS, type DatasetDetail, type DetailView, type DetailFilter, type DetailRow, type FirewallEvent, type ZoneDetail, type ZoneDetailPending } from '@/lib/traffic-types';
import { Alert, Badge, Button, Card, Modal, SectionHeader, cx } from '@/components/ui';
import { bytes, dayLabel, num, pct, whole } from './format';

// One zone's (or account's) security events and requests (see src/lib/traffic-security.ts). Any card, bar, IP,
// rule or ruleset opens the details window, narrowed to it; days open per hour, hours per minute.

/** No zone: the account, its busiest zones added up. */
export interface Target { month: string; account: string; zone?: string }

// ── Labels ──────────────────────────────────────────────────────────────────

const SOURCE: Record<string, string> = {
  firewallManaged: 'Managed rules', firewallCustom: 'Custom rules', firewallRules: 'Firewall rules (legacy)', ratelimit: 'Rate limiting rules',
  waf: 'WAF (legacy managed rules)', l7ddos: 'HTTP DDoS protection', bic: 'Browser integrity check', hot: 'Hotlink protection',
  securitylevel: 'Security level', uablock: 'User agent blocking', zonelockdown: 'Zone lockdown', ip: 'IP access rules', iprange: 'IP access rules',
  asn: 'IP access rules (ASN)', country: 'IP access rules (country)', botFight: 'Bot fight mode', botManagement: 'Bot management',
  superBotFight: 'Super bot fight mode', validation: 'Request validation', apiShield: 'API Shield', apiShieldSchemaValidation: 'API Shield schema validation',
  apiShieldTokenValidation: 'API Shield JWT validation', apiShieldSequenceMitigation: 'API Shield sequence mitigation', dlp: 'Data loss prevention',
  sanitycheck: 'Sanity check', firewallrules: 'Firewall rules (legacy)', 'l7ddos-managed': 'HTTP DDoS protection', linkMaze: 'AI Labyrinth',
};
const sourceLabel = (s: string) => SOURCE[s] ?? (s || 'Unknown');

const ACTION_LABEL: Record<string, string> = {
  block: 'Block', drop: 'Drop', challenge: 'Interactive challenge', jschallenge: 'JS challenge', managed_challenge: 'Managed challenge',
  challenge_solved: 'Challenge solved', challenge_failed: 'Challenge failed', challenge_bypassed: 'Challenge bypassed', jschallenge_solved: 'JS challenge solved',
  jschallenge_failed: 'JS challenge failed', jschallenge_bypassed: 'JS challenge bypassed', managed_challenge_skipped: 'Managed challenge skipped',
  managed_challenge_non_interactive_solved: 'Managed challenge solved', managed_challenge_interactive_solved: 'Managed challenge solved (interactive)',
  managed_challenge_bypassed: 'Managed challenge bypassed', log: 'Log', allow: 'Allow', bypass: 'Bypass', skip: 'Skip', connection_close: 'Close connection',
  rewrite: 'Rewrite', redirect: 'Redirect', unknown: 'Unknown',
};
const actionLabel = (a: string) => ACTION_LABEL[a] ?? (a || 'Unknown');
function actionTone(a: string): 'bad' | 'warn' | 'info' | 'ok' | 'neutral' {
  if (/^(block|drop|connection_close)$/.test(a) || /failed/.test(a)) return 'bad';
  if (/challenge/.test(a) && !/solved|bypassed|skipped/.test(a)) return 'warn';
  if (a === 'log') return 'info';
  if (/^(allow|bypass|skip)$/.test(a) || /solved|bypassed|skipped/.test(a)) return 'ok';
  return 'neutral';
}

const CACHE_LABEL: Record<string, string> = { hit: 'Hit', miss: 'Miss', dynamic: 'Dynamic (not cached)', expired: 'Expired', revalidated: 'Revalidated', updating: 'Updating', stale: 'Stale', bypass: 'Bypass', none: 'None', unknown: 'Unknown' };

// ── Loading (with "still reading" polling) ──────────────────────────────────

function useDetail(t: Target, filter: DetailFilter | null, refresh: number) {
  const [d, setD] = useState<ZoneDetail | null>(null);
  const [pending, setPending] = useState<ZoneDetailPending | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const qs = useMemo(() => new URLSearchParams({ month: t.month, account: t.account, ...(t.zone ? { zone: t.zone } : {}), ...(filter?.ip ? { ip: filter.ip } : {}), ...(filter?.rule ? { rule: filter.rule } : {}), ...(filter?.ruleset ? { ruleset: filter.ruleset } : {}), ...(filter?.day ? { day: filter.day } : {}), ...(filter?.hour !== undefined ? { hour: String(filter.hour) } : {}), ...(filter?.view ? { view: filter.view } : {}), ...(filter?.part ? { part: filter.part } : {}) }).toString(), [t.month, t.account, t.zone, filter?.ip, filter?.rule, filter?.ruleset, filter?.day, filter?.hour, filter?.view, filter?.part]);
  useEffect(() => {
    const mine = ++seq.current;
    setBusy(true); setError(''); setPending(null); setD(null);
    void (async () => {
      try {
        // Every load reads Cloudflare; the polls name the read they wait for.
        for (let job = ''; ;) {
          const r = await api<ZoneDetail | ZoneDetailPending>(`/api/traffic/detail?${qs}${job ? `&job=${encodeURIComponent(job)}` : ''}`);
          if (mine !== seq.current) return;
          if (!r || typeof r !== 'object') throw new Error('The console sent an empty answer');
          if (!('pending' in r)) {
            if (!r.security || !r.requests) throw new Error('The worker answered in an older format: it restarts with the new version once idle (or cancel its run in GitHub › Actions › Console worker).');
            setD(r); setPending(null);
            break;
          }
          setPending(r);
          job = r.job;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          if (mine !== seq.current) return;
        }
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    })();
    // Closed or left: the loop ends (its polls would keep the worker busy for the next page).
    return () => { seq.current++; };
  }, [qs, refresh]);
  return { d, pending, error, busy };
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Reading({ what, pending }: { what: string; pending: ZoneDetailPending | null }) {
  return (
    <div className="py-8 text-center text-sm text-muted">
      <RefreshCw className="mx-auto mb-3 size-5 animate-spin text-faint" />
      Reading {what} from Cloudflare…
      {pending && pending.total > 0 && (
        <div className="mx-auto mt-3 max-w-xs">
          <div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-signal transition-all" style={{ width: `${Math.min(100, (pending.done / pending.total) * 100)}%` }} /></div>
          <div className="mt-1 text-xs tabular-nums text-faint">{pending.done} of {pending.total} queries done</div>
        </div>
      )}
      {pending?.note && <div className="mx-auto mt-2 max-w-md text-xs text-warn">{pending.note}</div>}
    </div>
  );
}

/** What was read, for how long Cloudflare keeps it, and anything left out. */
function Coverage({ ds }: { ds: DatasetDetail }) {
  if (!ds.available) return null;
  return (
    <div className="space-y-1 text-[11.5px] text-muted">
      <p>
        {ds.since && ds.until && <>Covers {utc(ds.since)} – {utc(ds.until)}</>}
        {ds.retentionDays !== null && <> · Cloudflare keeps this for {ds.retentionDays} days on this zone&apos;s plan</>}
        {ds.parts > 1 && <> · read in {ds.parts} parts (top lists are the best of each part)</>}
      </p>
      {ds.notes.map((n) => <p key={n} className="text-faint">{n}</p>)}
    </div>
  );
}

// The time series of a window: per day (month), per hour (a day) or per minute (an hour).
type TimeAlias = 'daily' | 'hourly' | 'minutes';
const TIME_KEY: Record<TimeAlias, string> = { daily: 'date', hourly: 'datetimeHour', minutes: 'datetimeMinute' };
const timeAliasOf = (b: Record<string, DetailRow[]>): TimeAlias | null => (b.minutes ? 'minutes' : b.hourly ? 'hourly' : b.daily ? 'daily' : null);
const timeLabel = (alias: TimeAlias, v: string) => (alias === 'daily' ? dayLabel(v) : alias === 'hourly' ? `${v.slice(11, 13)}:00` : v.slice(11, 16));
const PER: Record<TimeAlias, string> = { daily: 'day', hourly: 'hour', minutes: 'minute' };

/** Every slot of the window with zero where nothing happened: all 24 hours of a day, all 60 minutes of an hour, every day in between. */
function fillTime(alias: TimeAlias, rows: DetailRow[]): DetailRow[] {
  const key = TIME_KEY[alias];
  const at = (prefix: string) => rows.find((r) => r.dims[key].startsWith(prefix));
  const zero = (v: string): DetailRow => ({ dims: { [key]: v }, count: 0, ...(rows[0].bytes !== undefined ? { bytes: 0 } : {}) });
  if (alias === 'hourly') {
    const day = rows[0].dims[key].slice(0, 10);
    return Array.from({ length: 24 }, (_, h) => { const p = `${day}T${String(h).padStart(2, '0')}`; return at(p) ?? zero(`${p}:00:00Z`); });
  }
  if (alias === 'minutes') {
    const hour = rows[0].dims[key].slice(0, 13);
    return Array.from({ length: 60 }, (_, m) => { const p = `${hour}:${String(m).padStart(2, '0')}`; return at(p) ?? zero(`${p}:00Z`); });
  }
  const out: DetailRow[] = [];
  for (let t = Date.parse(`${rows[0].dims[key]}T00:00:00Z`); t <= Date.parse(`${rows[rows.length - 1].dims[key]}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push(at(d) ?? zero(d));
  }
  return out;
}

/** An ISO time as "29 Oct 05:00 UTC" (the windows are UTC days and hours). */
const utc = (iso: string) => `${dayLabel(iso)} ${iso.slice(11, 16)} UTC`;

/** Events or requests over time: one series, the exact number on hover; a day or an hour opens its own detail. */
function TimeChart({ b, label, onPick }: { b: Record<string, DetailRow[]>; label: string; onPick?: (alias: TimeAlias, row: DetailRow) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const alias = timeAliasOf(b);
  if (!alias || !b[alias].length) return null;
  const rows = fillTime(alias, b[alias]);
  const key = TIME_KEY[alias];
  const clickable = !!onPick && alias !== 'minutes';
  const max = Math.max(1, ...rows.map((r) => r.count));
  const h = hover !== null ? rows[hover] : null;
  return (
    <div>
      <div className="mb-1 flex justify-between gap-3 text-xs text-muted">
        <span><span className="font-medium text-ink-2">{label} per {PER[alias]}</span>{clickable && <span className="text-faint"> · click a bar for that {PER[alias]}&apos;s detail</span>}</span>
        <span className="text-faint tabular-nums">{num(max)}</span>
      </div>
      <div className="relative">
        <div className="flex h-24 items-end gap-0.5 border-b border-line-strong" onMouseLeave={() => setHover(null)}>
          {rows.map((r, i) => (
            <button key={r.dims[key]} type="button" aria-label={`${timeLabel(alias, r.dims[key])}: ${whole.format(r.count)}`} disabled={!clickable}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} onClick={() => clickable && onPick!(alias, r)}
              className={cx('flex h-full min-w-0 flex-1 items-end rounded-t-sm focus:outline-none', hover === i && 'bg-raised/60', clickable && 'cursor-pointer')}>
              <span className={cx('w-full rounded-t-sm bg-signal', clickable && hover === i && 'bg-signal-soft')} style={{ height: `${(r.count / max) * 100}%` }} />
            </button>
          ))}
        </div>
        {h && hover !== null && (
          <div className="pointer-events-none absolute bottom-full z-20 mb-1 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-pop"
            style={{ left: `${((hover + 0.5) / rows.length) * 100}%`, transform: `translateX(${hover < rows.length / 3 ? '-10%' : hover > (rows.length * 2) / 3 ? '-90%' : '-50%'})` }}>
            <span className="text-muted">{alias === 'daily' ? dayLabel(h.dims[key]) : `${dayLabel(h.dims[key])} ${timeLabel(alias, h.dims[key])}`}</span>{' '}
            <span className="tabular-nums text-ink">{num(h.count)}</span>{h.bytes !== undefined && <span className="text-muted"> · {bytes(h.bytes)}</span>}
            {clickable && <div className="text-[10.5px] text-faint">Click for this {PER[alias]}&apos;s detail</div>}
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-faint"><span>{timeLabel(alias, rows[0].dims[key])}</span><span>{timeLabel(alias, rows[rows.length - 1].dims[key])}</span></div>
    </div>
  );
}

/** What a click opens: an IP, a rule, a ruleset, or a time (day / hour) — with the time already chosen kept. */
interface On { ip: (ip: string) => void; rule: (rule: string) => void; ruleset: (ruleset: string) => void; time?: (alias: TimeAlias, row: DetailRow) => void; view?: (v: DetailView, label: string) => void }

/** One headline number; with onOpen it opens that slice. */
function Figure({ label, value, exact, sub, onOpen }: { label: string; value: string; exact?: number; sub?: string; onOpen?: () => void }) {
  const body = (
    <>
      <div className="eyebrow">{label}</div>
      <div className="mt-1 text-[26px] font-semibold tabular-nums" title={exact !== undefined ? whole.format(exact) : undefined}>{value}</div>
      {sub && <div className="text-[11.5px] text-muted">{sub}</div>}
    </>
  );
  if (!onOpen) return <div>{body}</div>;
  return (
    <button type="button" onClick={onOpen} aria-label={`${label}: open the details`} title="Open the details"
      className="-m-2 rounded-lg p-2 text-left hover:bg-raised/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal">
      {body}
    </button>
  );
}
const sumOf = (rows: DetailRow[] | undefined, keep: (r: DetailRow) => boolean) => (rows ?? []).filter(keep).reduce((n, r) => n + r.count, 0);
const bytesOf = (rows: DetailRow[] | undefined, keep: (r: DetailRow) => boolean) => (rows ?? []).filter(keep).reduce((n, r) => n + (r.bytes ?? 0), 0);

/** A ranked list with a share bar; long lists open on request. */
function BarList({ title, rows, label, sub, total, withBytes, onPick, empty = 'Nothing' }: {
  title: string; rows: DetailRow[] | undefined; label: (r: DetailRow) => ReactNode; sub?: (r: DetailRow) => ReactNode; total: number; withBytes?: boolean;
  onPick?: (r: DetailRow) => void; empty?: string;
}) {
  const [all, setAll] = useState(false);
  if (!rows) return null;
  const shown = all ? rows : rows.slice(0, 10);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-2">{title}</div>
      {!rows.length ? <p className="text-xs text-faint">{empty}</p> : (
        <ul className="space-y-1.5 text-xs">
          {shown.map((r, i) => (
            <li key={i}>
              <button type="button" disabled={!onPick} onClick={() => onPick?.(r)} className={cx('block w-full text-left', onPick && 'rounded hover:bg-raised/50')}>
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-ink-2" title={typeof label(r) === 'string' ? (label(r) as string) : undefined}>{label(r)}</span>
                  {withBytes && r.bytes !== undefined && <span className="shrink-0 tabular-nums text-faint">{bytes(r.bytes)}</span>}
                  <span className="w-14 shrink-0 text-right tabular-nums text-ink" title={`${whole.format(r.count)} · ${pct(r.count, total)}`}>{num(r.count)}</span>
                </div>
                {sub && <div className="truncate text-[10.5px] text-faint">{sub(r)}</div>}
                <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-signal/80" style={{ width: `${(r.count / max) * 100}%` }} /></div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 10 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-2 text-xs text-muted hover:text-ink">{all ? 'Show fewer' : `Show all ${rows.length}`}</button>
      )}
    </div>
  );
}

const ipSub = (r: DetailRow) => [r.dims.clientCountryName, r.dims.clientASNDescription].filter(Boolean).join(' · ');

function RulesTable({ rows, names, total, onPick }: { rows: DetailRow[]; names: Record<string, string>; total: number; onPick: (rule: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 15);
  if (!rows.length) return <p className="text-xs text-faint">No rule matched.</p>;
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[760px] text-left text-[12px]">
          <thead className="bg-raised/50 text-muted"><tr>{['Rule', 'Ruleset / source', 'Action', 'Events', 'Share'].map((h, i) => <th key={h} className={cx('px-3 py-2 font-medium', i >= 3 && 'text-right')}>{h}</th>)}</tr></thead>
          <tbody>
            {shown.map((r, i) => {
              const rid = r.dims.ruleId;
              return (
                <tr key={i} className={cx('border-t border-line/50', rid && 'cursor-pointer hover:bg-raised/40')} onClick={() => rid && onPick(rid)}>
                  <td className="px-3 py-2">
                    <div className="text-ink">{r.dims.description || <span className="text-muted">(no description)</span>}</div>
                    {rid && <div className="font-mono text-[10.5px] text-faint">{rid}</div>}
                  </td>
                  <td className="px-3 py-2 text-ink-2">
                    <div>{(r.dims.rulesetId && names[r.dims.rulesetId]) || sourceLabel(r.dims.source)}</div>
                    {r.dims.rulesetId && names[r.dims.rulesetId] && <div className="text-[10.5px] text-faint">{sourceLabel(r.dims.source)}</div>}
                  </td>
                  <td className="px-3 py-2"><Badge tone={actionTone(r.dims.action) === 'neutral' ? 'neutral' : actionTone(r.dims.action) as 'bad' | 'warn' | 'info' | 'ok'}>{actionLabel(r.dims.action)}</Badge></td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink" title={whole.format(r.count)}>{num(r.count)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{pct(r.count, total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 15 && <button type="button" onClick={() => setAll(!all)} className="mt-2 text-xs text-muted hover:text-ink">{all ? 'Show fewer' : `Show all ${rows.length} rules`}</button>}
    </div>
  );
}

function IpTable({ rows, total, withBytes, onPick, what }: { rows: DetailRow[]; total: number; withBytes?: boolean; onPick: (ip: string) => void; what: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 15);
  if (!rows.length) return <p className="text-xs text-faint">None.</p>;
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[620px] text-left text-[12px]">
          <thead className="bg-raised/50 text-muted"><tr>{['IP address', 'Country', 'Network (ASN)', what, ...(withBytes ? ['Bandwidth'] : []), 'Share'].map((h, i) => <th key={h} className={cx('px-3 py-2 font-medium', i >= 3 && 'text-right')}>{h}</th>)}</tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.dims.clientIP} className="cursor-pointer border-t border-line/50 hover:bg-raised/40" onClick={() => onPick(r.dims.clientIP)}>
                <td className="px-3 py-2 font-mono text-ink">{r.dims.clientIP}</td>
                <td className="px-3 py-2 text-ink-2">{r.dims.clientCountryName || '—'}</td>
                <td className="max-w-[260px] truncate px-3 py-2 text-ink-2" title={r.dims.clientASNDescription}>{r.dims.clientASNDescription || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-ink" title={whole.format(r.count)}>{num(r.count)}</td>
                {withBytes && <td className="px-3 py-2 text-right tabular-nums text-muted">{r.bytes !== undefined ? bytes(r.bytes) : '—'}</td>}
                <td className="px-3 py-2 text-right tabular-nums text-muted">{pct(r.count, total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 15 && <button type="button" onClick={() => setAll(!all)} className="mt-2 text-xs text-muted hover:text-ink">{all ? 'Show fewer' : `Show all ${rows.length} IPs`}</button>}
    </div>
  );
}

function EventsTable({ events, names, onIp, onRule }: { events: FirewallEvent[]; names: Record<string, string>; onIp: (ip: string) => void; onRule: (rule: string) => void }) {
  const withZone = events.some((e) => e.zone);
  const [n, setN] = useState(25);
  const shown = events.slice(0, n);
  if (!events.length) return <p className="text-xs text-faint">No security events in this time.</p>;
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[980px] text-left text-[11.5px]">
          <thead className="bg-raised/50 text-muted"><tr>{['Time (UTC)', ...(withZone ? ['Zone'] : []), 'Action', 'Rule', 'Client', 'Request', 'Status', 'Ray ID'].map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody className="align-top">
            {shown.map((e, i) => {
              const a = s(e.action);
              return (
                <tr key={`${s(e.rayName)}-${i}`} className="border-t border-line/50">
                  <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-ink-2">{s(e.datetime).replace('T', ' ').replace(/(\.\d+)?Z$/, '')}</td>
                  {withZone && <td className="px-3 py-1.5 text-ink-2">{s(e.zone)}</td>}
                  <td className="px-3 py-1.5"><Badge tone={actionTone(a) === 'neutral' ? 'neutral' : actionTone(a) as 'bad' | 'warn' | 'info' | 'ok'}>{actionLabel(a)}</Badge></td>
                  <td className="max-w-[240px] px-3 py-1.5">
                    <button type="button" disabled={!e.ruleId} onClick={() => e.ruleId && onRule(s(e.ruleId))} className="text-left text-ink-2 enabled:hover:text-ink enabled:hover:underline">
                      {s(e.description) || s(e.ruleId) || '—'}
                    </button>
                    <div className="text-[10.5px] text-faint">{(e.rulesetId && names[s(e.rulesetId)]) || sourceLabel(s(e.source))}</div>
                  </td>
                  <td className="px-3 py-1.5">
                    <button type="button" onClick={() => e.clientIP && onIp(s(e.clientIP))} className="font-mono text-ink hover:underline">{s(e.clientIP)}</button>
                    <div className="text-[10.5px] text-faint">{[s(e.clientCountryName), s(e.clientASNDescription)].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="max-w-[320px] px-3 py-1.5">
                    <div className="break-all font-mono text-ink-2"><span className="text-faint">{s(e.clientRequestHTTPMethodName)} </span>{s(e.clientRequestHTTPHost)}{s(e.clientRequestPath)}{s(e.clientRequestQuery)}</div>
                    {e.userAgent && <div className="truncate text-[10.5px] text-faint" title={s(e.userAgent)}>{s(e.userAgent)}</div>}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-ink-2">{s(e.edgeResponseStatus) || '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-[10.5px] text-faint">{s(e.rayName) || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <More shown={shown.length} total={events.length} onMore={() => setN(n + 100)} onLess={() => setN(25)} what="events" />
    </div>
  );
}

function More({ shown, total, onMore, onLess, what }: { shown: number; total: number; onMore: () => void; onLess: () => void; what: string }) {
  if (total <= 25) return null;
  return (
    <div className="mt-2 flex items-center gap-3 text-xs text-muted">
      <span className="tabular-nums">Showing {num(shown)} of {num(total)} {what}</span>
      {shown < total && <button type="button" onClick={onMore} className="hover:text-ink">Show {Math.min(100, total - shown)} more</button>}
      {shown > 25 && <button type="button" onClick={onLess} className="hover:text-ink">Show fewer</button>}
    </div>
  );
}

/** Single requests, newest first: who asked for what, and what the edge answered. */
function RequestsTable({ rows, onIp }: { rows: FirewallEvent[]; onIp: (ip: string) => void }) {
  const withZone = rows.some((e) => e.zone);
  const [n, setN] = useState(25);
  const shown = rows.slice(0, n);
  if (!rows.length) return <p className="text-xs text-faint">No requests in this time.</p>;
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[980px] text-left text-[11.5px]">
          <thead className="bg-raised/50 text-muted"><tr>{['Time (UTC)', ...(withZone ? ['Zone'] : []), 'Client', 'Request', 'Status', 'Cache', 'Bytes', 'Ray ID'].map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody className="align-top">
            {shown.map((e, i) => (
              <tr key={`${s(e.rayName)}-${i}`} className="border-t border-line/50">
                <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-ink-2">{s(e.datetime).replace('T', ' ').replace(/(\.\d+)?Z$/, '')}</td>
                {withZone && <td className="px-3 py-1.5 text-ink-2">{s(e.zone)}</td>}
                <td className="px-3 py-1.5">
                  <button type="button" onClick={() => e.clientIP && onIp(s(e.clientIP))} className="font-mono text-ink hover:underline">{s(e.clientIP)}</button>
                  <div className="text-[10.5px] text-faint">{[s(e.clientCountryName), s(e.clientASNDescription)].filter(Boolean).join(' · ')}</div>
                </td>
                <td className="max-w-[360px] px-3 py-1.5">
                  <div className="break-all font-mono text-ink-2"><span className="text-faint">{s(e.clientRequestHTTPMethodName)} </span>{s(e.clientRequestHTTPHost)}{s(e.clientRequestPath)}{s(e.clientRequestQuery)}</div>
                  <div className="truncate text-[10.5px] text-faint" title={s(e.userAgent)}>{[s(e.clientRequestHTTPProtocol), s(e.userAgent)].filter(Boolean).join(' · ')}</div>
                </td>
                <td className="px-3 py-1.5 tabular-nums text-ink-2">{s(e.edgeResponseStatus) || '—'}</td>
                <td className="px-3 py-1.5 text-ink-2">{CACHE_LABEL[s(e.cacheStatus)] ?? (s(e.cacheStatus) || '—')}</td>
                <td className="px-3 py-1.5 tabular-nums text-ink-2">{e.edgeResponseBytes !== undefined && e.edgeResponseBytes !== null ? bytes(Number(e.edgeResponseBytes)) : '—'}</td>
                <td className="px-3 py-1.5 font-mono text-[10.5px] text-faint">{s(e.rayName) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <More shown={shown.length} total={rows.length} onMore={() => setN(n + 100)} onLess={() => setN(25)} what="requests" />
    </div>
  );
}

// ── Managed rules and OWASP ─────────────────────────────────────────────────

/** OWASP Core Rule Set categories, by the first three digits of the rule number. */
const CRS: Record<string, string> = {
  '911': 'Method enforcement', '913': 'Scanner detection', '920': 'Protocol enforcement', '921': 'Protocol attack', '922': 'Multipart attack',
  '930': 'Local file inclusion (LFI)', '931': 'Remote file inclusion (RFI)', '932': 'Remote code execution (RCE)', '933': 'PHP injection',
  '934': 'Generic / Node.js injection', '941': 'Cross-site scripting (XSS)', '942': 'SQL injection (SQLi)', '943': 'Session fixation',
  '944': 'Java injection', '949': 'Inbound anomaly score', '950': 'Data leakage', '951': 'SQL error leakage', '952': 'Java leakage', '953': 'PHP leakage',
  '954': 'IIS leakage', '959': 'Outbound anomaly score', '980': 'Correlation',
};
const crsOf = (description: string) => /^(\d{6})\b/.exec(description.trim())?.[1] ?? '';
const crsCategory = (n: string) => (n ? CRS[n.slice(0, 3)] ?? `CRS ${n.slice(0, 3)}` : 'Other');
const sensitivity = (t?: number) => (t === undefined ? 'default' : t >= 60 ? `${t} (low)` : t >= 40 ? `${t} (medium)` : `${t} (high)`);
const isManaged = (r: DetailRow, names: Record<string, string>) => r.dims.source === 'firewallManaged' || r.dims.source === 'waf' || (!!r.dims.rulesetId && r.dims.rulesetId in MANAGED_RULESETS) || (!!r.dims.rulesetId && /managed|owasp/i.test(names[r.dims.rulesetId] ?? ''));

function Deployed({ d }: { d: ZoneDetail }) {
  if (!d.managed && !d.managedNote) return null;
  const list = d.managed ?? [];
  return (
    <div>
      <div className="eyebrow mb-2">Managed rulesets deployed</div>
      {d.managedNote && <p className="mb-2 text-xs text-warn">{d.managedNote}</p>}
      {!list.length ? <p className="text-xs text-faint">No managed ruleset is deployed{d.zoneId ? ' on this zone' : ' on these zones'}.</p> : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[820px] text-left text-[12px]">
            <thead className="bg-raised/50 text-muted"><tr>{[...(d.zoneId ? [] : ['Zone']), 'Ruleset', 'Status', 'Applies to', 'Tuning', 'Overrides'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody className="align-top">
              {list.map((m, i) => {
                const owasp = m.rulesetId === OWASP_RULESET;
                const off = m.ruleOverrides.filter((x) => x.enabled === false).length;
                const changed = m.ruleOverrides.length - off;
                return (
                  <tr key={`${m.zone ?? ''}-${m.rulesetId}-${i}`} className="border-t border-line/50">
                    {!d.zoneId && <td className="px-3 py-2 text-ink-2">{m.zone}</td>}
                    <td className="px-3 py-2"><div className="text-ink">{m.name}</div>{m.description && m.description !== m.name && <div className="text-[10.5px] text-faint">{m.description}</div>}</td>
                    <td className="px-3 py-2"><Badge tone={m.enabled ? 'ok' : 'neutral'}>{m.enabled ? 'Enabled' : 'Disabled'}</Badge></td>
                    <td className="max-w-[260px] px-3 py-2 font-mono text-[11px] break-all text-ink-2">{m.expression === 'true' ? <span className="font-sans text-muted">All requests</span> : m.expression}</td>
                    <td className="px-3 py-2 text-ink-2">
                      {owasp ? (
                        <div className="space-y-0.5">
                          <div>Paranoia level <span className="text-ink">PL{m.paranoiaLevel}</span></div>
                          <div>Score threshold <span className="text-ink">{sensitivity(m.scoreThreshold)}</span></div>
                          <div>When exceeded <span className="text-ink">{actionLabel(m.anomalyAction ?? 'block')}</span></div>
                        </div>
                      ) : m.action ? <>All rules: <span className="text-ink">{actionLabel(m.action)}</span></> : <span className="text-muted">Default actions</span>}
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      {!off && !changed && !m.categoryOverrides.length ? <span className="text-muted">None</span> : (
                        <div className="space-y-0.5">
                          {off > 0 && <div>{off} rule{off === 1 ? '' : 's'} turned off</div>}
                          {changed > 0 && <div>{changed} rule{changed === 1 ? '' : 's'} changed</div>}
                          {m.categoryOverrides.map((c) => <div key={c.category} className="text-[11px] text-muted">{c.category}: {c.enabled === false ? 'off' : c.enabled ? 'on' : ''}{c.action ? ` ${actionLabel(c.action)}` : ''}</div>)}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ManagedSection({ d, onRule, onRuleset }: { d: ZoneDetail; onRule: (rule: string) => void; onRuleset: (ruleset: string) => void }) {
  const rules = d.security.breakdowns.rules ?? [];
  // Without the rule totals nothing is known about hits: say so instead of "nothing matched".
  const unknown = <p className="text-xs text-faint">Not known: the rule totals could not be read.</p>;
  const known = !!d.security.breakdowns.rules;
  const managed = rules.filter((r) => isManaged(r, d.rulesetNames));
  // Hits per managed ruleset, with the action mix and its busiest rules.
  interface Hit { id: string; name: string; count: number; actions: Map<string, number>; rules: DetailRow[] }
  const byRuleset = new Map<string, Hit>();
  for (const r of managed) {
    const id = r.dims.rulesetId || r.dims.source;
    const g: Hit = byRuleset.get(id) ?? { id: r.dims.rulesetId, name: d.rulesetNames[r.dims.rulesetId] ?? sourceLabel(r.dims.source), count: 0, actions: new Map<string, number>(), rules: [] };
    g.count += r.count;
    g.actions.set(r.dims.action, (g.actions.get(r.dims.action) ?? 0) + r.count);
    g.rules.push(r);
    byRuleset.set(id, g);
  }
  const groups = [...byRuleset.values()].sort((a, b) => b.count - a.count);
  const owasp = rules.filter((r) => r.dims.rulesetId === OWASP_RULESET || /^9[1-8]\d{4}\b/.test(r.dims.description) && r.dims.source === 'firewallManaged');
  const anomaly = owasp.filter((r) => r.dims.ruleId === OWASP_ANOMALY_RULE || crsOf(r.dims.description).startsWith('949'));
  const contributing = owasp.filter((r) => !anomaly.includes(r));
  const byCategory = new Map<string, number>();
  for (const r of contributing) byCategory.set(crsCategory(crsOf(r.dims.description)), (byCategory.get(crsCategory(crsOf(r.dims.description))) ?? 0) + r.count);
  const anomalyByAction = new Map<string, number>();
  for (const r of anomaly) anomalyByAction.set(r.dims.action, (anomalyByAction.get(r.dims.action) ?? 0) + r.count);
  const deployedOwasp = (d.managed ?? []).filter((m) => m.rulesetId === OWASP_RULESET);

  return (
    <div className="space-y-6">
      <Deployed d={d} />
      <div>
        <div className="eyebrow mb-2">Managed rulesets hit</div>
        {!known ? unknown : !groups.length ? <p className="text-xs text-faint">No managed rule matched.</p> : (
          <div className="grid gap-3 lg:grid-cols-2">
            {groups.map((g) => (
              <div key={g.id || g.name} className="rounded-lg border border-line p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-ink">{g.name}</div>
                    {g.id && <div className="font-mono text-[10.5px] text-faint">{g.id}</div>}
                  </div>
                  <div className="text-right"><div className="text-[18px] font-semibold tabular-nums">{num(g.count)}</div><div className="text-[10.5px] text-faint">events</div></div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {[...g.actions].sort((a, b) => b[1] - a[1]).map(([a, n]) => { const tone = actionTone(a); return <Badge key={a} tone={tone}>{actionLabel(a)} · {num(n)}</Badge>; })}
                </div>
                <ul className="mt-2 space-y-0.5 text-[11.5px]">
                  {g.rules.slice(0, 4).map((r, i) => (
                    <li key={i}><button type="button" onClick={() => r.dims.ruleId && onRule(r.dims.ruleId)} className="flex w-full gap-2 text-left hover:text-ink">
                      <span className="min-w-0 flex-1 truncate text-ink-2">{r.dims.description || r.dims.ruleId}</span><span className="tabular-nums text-muted">{num(r.count)}</span>
                    </button></li>
                  ))}
                </ul>
                {g.id && <button type="button" onClick={() => onRuleset(g.id)} className="mt-2 text-xs text-signal hover:underline">Who triggers it →</button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {(owasp.length > 0 || deployedOwasp.length > 0) && (
        <div className="rounded-lg border border-line p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[13px] font-semibold text-ink">OWASP Core Ruleset</div>
            {deployedOwasp[0] && <div className="text-xs text-muted">PL{deployedOwasp[0].paranoiaLevel} · threshold {sensitivity(deployedOwasp[0].scoreThreshold)} · {actionLabel(deployedOwasp[0].anomalyAction ?? 'block')} when exceeded</div>}
          </div>
          <p className="mb-3 text-xs text-muted">
            OWASP rules add to a request&apos;s anomaly score; only &ldquo;949110: Inbound Anomaly Score Exceeded&rdquo; acts on the request, once the score reaches the threshold. The rules below show what pushed requests up.
          </p>
          {!known ? unknown : !owasp.length ? <p className="text-xs text-faint">No OWASP rule matched this month.</p> : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <div><div className="eyebrow">Requests over the threshold</div><div className="mt-1 text-[22px] font-semibold tabular-nums">{num(anomaly.reduce((n, r) => n + r.count, 0))}</div></div>
                <div className="flex flex-wrap gap-1">{[...anomalyByAction].map(([a, n]) => <Badge key={a} tone={actionTone(a)}>{actionLabel(a)} · {num(n)}</Badge>)}</div>
                <div><div className="eyebrow">Rule matches adding to scores</div><div className="mt-1 text-[22px] font-semibold tabular-nums">{num(contributing.reduce((n, r) => n + r.count, 0))}</div></div>
              </div>
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <BarList title="Attack categories" rows={[...byCategory].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ dims: { category: c }, count: n }))} label={(r) => r.dims.category} total={contributing.reduce((n, r) => n + r.count, 0)} />
                <div className="min-w-0">
                  <div className="eyebrow mb-2">OWASP rules that matched</div>
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="w-full min-w-[520px] text-left text-[12px]">
                      <thead className="bg-raised/50 text-muted"><tr>{['Rule', 'Category', 'Action', 'Matches'].map((h, i) => <th key={h} className={cx('px-3 py-2 font-medium', i === 3 && 'text-right')}>{h}</th>)}</tr></thead>
                      <tbody>
                        {owasp.slice(0, 40).map((r, i) => (
                          <tr key={i} className="cursor-pointer border-t border-line/50 hover:bg-raised/40" onClick={() => r.dims.ruleId && onRule(r.dims.ruleId)}>
                            <td className="px-3 py-1.5 text-ink">{r.dims.description || r.dims.ruleId}</td>
                            <td className="px-3 py-1.5 text-ink-2">{crsCategory(crsOf(r.dims.description))}</td>
                            <td className="px-3 py-1.5"><Badge tone={actionTone(r.dims.action)}>{actionLabel(r.dims.action)}</Badge></td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-ink" title={whole.format(r.count)}>{num(r.count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <button type="button" onClick={() => onRuleset(OWASP_RULESET)} className="text-xs text-signal hover:underline">Who triggers OWASP rules →</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── The two sections ────────────────────────────────────────────────────────

/** Account level: which zones are added up, and which are not (no traffic, too many, no access). */
function ZonesRead({ d }: { d: ZoneDetail }) {
  if (!d.zones) return null;
  const by = (st: string) => d.zones!.filter((z) => z.status === st);
  const read = by('read'), quiet = by('no traffic'), out = by('left out'), bad = by('unavailable');
  return (
    <div className="text-[11.5px] text-muted">
      Added up from {read.length} zone{read.length === 1 ? '' : 's'}{read.length ? `: ${read.map((z) => z.name).join(', ')}` : ''}.
      {quiet.length > 0 && <> {quiet.length} without traffic this month.</>}
      {out.length > 0 && <> {out.length} quieter zone{out.length === 1 ? '' : 's'} left out — choose one as the zone to see it.</>}
      {bad.length > 0 && <span className="text-warn"> Not readable: {bad.map((z) => `${z.name} (${z.message ?? 'no access'})`).join('; ')}.</span>}
    </div>
  );
}


/** The grouped numbers (totals, charts, top lists) could not be read: why, and whether anything else below came in. */
function Unread({ message, what, more }: { message?: string; what: string; more: boolean }) {
  return (
    <Alert tone={more ? 'warn' : 'info'} title={more ? `The totals and top lists of ${what} could not be read` : undefined}>
      {message ?? 'Not available'}{more ? ' — what Cloudflare did send is shown below.' : ''}
    </Alert>
  );
}

function SecurityBody({ d, on }: { d: ZoneDetail; on: On }) {
  const { ip: onIp, rule: onRule, ruleset: onRuleset } = on;
  const s = d.security;
  const b = s.breakdowns;
  // Whatever did come in is shown, also when the grouped numbers could not be read.
  const grouped = s.available;
  return (
    <div className="space-y-6">
      {!grouped && <Unread message={s.message} what="security events" more={s.events.length > 0 || !!d.managed?.length} />}
      <Coverage ds={s} />
      <ZonesRead d={d} />
      {grouped && <>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <Figure label="Security events" value={num(s.total)} exact={s.total} />
        {b.actions && (() => {
          const mitigated = sumOf(b.actions, (r) => MITIGATING_ACTIONS.includes(r.dims.action));
          const rest = sumOf(b.actions, (r) => !MITIGATING_ACTIONS.includes(r.dims.action));
          return (
            <>
              <Figure label="Mitigated" value={num(mitigated)} exact={mitigated} sub={`${pct(mitigated, s.total)} · blocked or challenged`} onOpen={on.view && (() => on.view!('threats', 'Mitigated'))} />
              <Figure label="Not mitigated" value={num(rest)} exact={rest} sub={`${pct(rest, s.total)} · logged, skipped or allowed`} onOpen={on.view && (() => on.view!('unmitigated', 'Not mitigated'))} />
            </>
          );
        })()}
        <div className="flex flex-wrap gap-1.5">
          {(b.actions ?? []).map((r) => {
            const tone = actionTone(r.dims.action);
            return <Badge key={r.dims.action} tone={tone === 'neutral' ? 'neutral' : tone}>{actionLabel(r.dims.action)} · {num(r.count)}</Badge>;
          })}
        </div>
      </div>
      <TimeChart b={b} label="Events" onPick={on.time} />
      {b.rules && (
        <div>
          <div className="eyebrow mb-2">Rules that matched</div>
          <p className="mb-2 text-xs text-muted">Managed rules, custom rules, rate limiting and other security features — open a rule to see who triggered it.</p>
          <RulesTable rows={b.rules} names={d.rulesetNames} total={s.total} onPick={onRule} />
        </div>
      )}
      </>}
      <ManagedSection d={d} onRule={onRule} onRuleset={onRuleset} />
      {grouped && <>
      {b.ips && (
        <div>
          <div className="eyebrow mb-2">Top client IPs</div>
          <IpTable rows={b.ips} total={s.total} onPick={onIp} what="Events" />
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {b.zones && <BarList title="By zone" rows={b.zones} label={(r) => r.dims.zone} total={s.total} />}
        <BarList title="By source" rows={b.sources} label={(r) => sourceLabel(r.dims.source)} total={s.total} />
        <BarList title="Paths" rows={b.paths} label={(r) => <span className="font-mono">{r.dims.clientRequestPath || '/'}</span>} total={s.total} />
        <BarList title="Hosts" rows={b.hosts} label={(r) => r.dims.clientRequestHTTPHost || '—'} total={s.total} />
        <BarList title="Countries" rows={b.countries} label={(r) => r.dims.clientCountryName || 'Unknown'} total={s.total} />
        <BarList title="Networks (ASN)" rows={b.asns} label={(r) => r.dims.clientASNDescription || `AS${r.dims.clientAsn}`} sub={(r) => (r.dims.clientAsn ? `AS${r.dims.clientAsn}` : '')} total={s.total} />
        <BarList title="HTTP methods" rows={b.methods} label={(r) => r.dims.clientRequestHTTPMethodName || '—'} total={s.total} />
      </div>
      <BarList title="User agents" rows={b.userAgents} label={(r) => <span className="font-mono text-[11px]">{r.dims.userAgent || '(none)'}</span>} total={s.total} />
      </>}
      {(grouped || s.events.length > 0) && <div>
        <div className="eyebrow mb-2">Single events</div>
        {s.eventsSince && <p className="mb-2 text-xs text-muted">The newest {num(s.events.length)} events since {fmtDate(s.eventsSince)}{grouped ? ' — open a day or an hour on the chart for every event in it' : ''}.</p>}
        <EventsTable events={s.events} names={d.rulesetNames} onIp={onIp} onRule={onRule} />
      </div>}
    </div>
  );
}

function RequestsBody({ d, on }: { d: ZoneDetail; on: On }) {
  const onIp = on.ip;
  const q = d.requests;
  const b = q.breakdowns;
  const alias = timeAliasOf(b);
  const totalBytes = (alias ? b[alias] : []).reduce((n, r) => n + (r.bytes ?? 0), 0);
  const grouped = q.available;
  return (
    <div className="space-y-6">
      {!grouped && <Unread message={q.message} what="requests" more={!!q.samples?.length} />}
      <Coverage ds={q} />
      {grouped && <>
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <Figure label="Requests" value={num(q.total)} exact={q.total} />
        {totalBytes > 0 && <Figure label="Bandwidth" value={bytes(totalBytes)} />}
        {b.cache && (() => {
          const cached = (r: DetailRow) => CACHED_STATUSES.includes(r.dims.cacheStatus);
          const edge = sumOf(b.cache, cached), origin = sumOf(b.cache, (r) => !cached(r));
          const edgeBytes = bytesOf(b.cache, cached), originBytes = bytesOf(b.cache, (r) => !cached(r));
          return (
            <>
              <Figure label="Served by Cloudflare" value={num(edge)} exact={edge} sub={`${pct(edge, q.total)}${edgeBytes ? ` · ${bytes(edgeBytes)}` : ''} · from cache`} onOpen={on.view && (() => on.view!('cache', 'Served by Cloudflare'))} />
              <Figure label="Served by origin" value={num(origin)} exact={origin} sub={`${pct(origin, q.total)}${originBytes ? ` · ${bytes(originBytes)}` : ''}`} onOpen={on.view && (() => on.view!('origin', 'Served by origin'))} />
            </>
          );
        })()}
      </div>
      <TimeChart b={b} label="Requests" onPick={on.time} />
      {b.ips && (
        <div>
          <div className="eyebrow mb-2">Top client IPs</div>
          <IpTable rows={b.ips} total={q.total} withBytes onPick={onIp} what="Requests" />
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {b.zones && <BarList title="By zone" rows={b.zones} label={(r) => r.dims.zone} total={q.total} withBytes />}
        <BarList title="Paths" rows={b.paths} label={(r) => <span className="font-mono">{r.dims.clientRequestPath || '/'}</span>} total={q.total} withBytes />
        <BarList title="Hosts" rows={b.hosts} label={(r) => r.dims.clientRequestHTTPHost || '—'} total={q.total} withBytes />
        <BarList title="Status codes" rows={b.statuses} label={(r) => r.dims.edgeResponseStatus || '—'} total={q.total} />
        <BarList title="Cache status" rows={b.cache} label={(r) => CACHE_LABEL[r.dims.cacheStatus] ?? r.dims.cacheStatus ?? '—'} total={q.total} withBytes />
        <BarList title="Countries" rows={b.countries} label={(r) => r.dims.clientCountryName || 'Unknown'} total={q.total} withBytes />
        <BarList title="Networks (ASN)" rows={b.asns} label={(r) => r.dims.clientASNDescription || `AS${r.dims.clientAsn}`} sub={(r) => (r.dims.clientAsn ? `AS${r.dims.clientAsn}` : '')} total={q.total} withBytes />
        <BarList title="HTTP methods" rows={b.methods} label={(r) => r.dims.clientRequestHTTPMethodName || '—'} total={q.total} />
        <BarList title="Browsers" rows={b.browsers} label={(r) => r.dims.userAgentBrowser || 'Unknown'} total={q.total} />
        <BarList title="Devices" rows={b.devices} label={(r) => r.dims.clientDeviceType || 'Unknown'} total={q.total} />
        <BarList title="HTTP protocol" rows={b.protocols} label={(r) => r.dims.clientRequestHTTPProtocol || 'Unknown'} total={q.total} />
      </div>
      <BarList title="User agents" rows={b.userAgents} label={(r) => <span className="font-mono text-[11px]">{r.dims.userAgent || '(none)'}</span>} total={q.total} />
      </>}
      {(q.samples?.length || q.samplesNote || (grouped && q.samples)) && (
        <div>
          <div className="eyebrow mb-2">Single requests</div>
          {q.samplesNote && <p className="mb-2 text-xs text-muted">{q.samplesNote}</p>}
          {q.samples && (
            <>
              {q.samplesSince && <p className="mb-2 text-xs text-muted">The newest {num(q.samples.length)} requests since {fmtDate(q.samplesSince)} (Cloudflare samples busy times){grouped ? ' — open a day or an hour on the chart for more of them' : ''}.</p>}
              <RequestsTable rows={q.samples} onIp={onIp} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── The details window: opened from any card, bar, IP, rule or ruleset ─────

/** What to show: whose (account or zone), narrowed how (IP / rule / ruleset, day / hour), and which section first. */
export interface DetailRequest { t: Target; filter?: DetailFilter; focus?: 'security' | 'requests'; label?: string }

const OpenCtx = createContext<(r: DetailRequest) => void>(() => {});
/** Opens the details window (inside <DetailHost>). */
export const useOpenDetail = () => useContext(OpenCtx);

const timeOf = (f?: DetailFilter): DetailFilter => (f?.day ? { day: f.day, ...(f.hour !== undefined ? { hour: f.hour } : {}) } : {});
/** The card a window was opened from: its view (cache, page views, bandwidth, threats) and section. */
const shapeOf = (f?: DetailFilter): DetailFilter => ({ ...(f?.view ? { view: f.view } : {}), ...(f?.part ? { part: f.part } : {}) });
const VIEW_LABEL: Record<DetailView, string> = {
  cache: 'Served from cache', origin: 'Served by origin', pages: 'Page views (HTML)', bytes: 'Ranked by bandwidth', threats: 'Blocked or challenged', unmitigated: 'Not mitigated',
};

/** Clicks inside a detail: an IP, rule or ruleset keeps the time; a bar narrows the time and keeps the IP / rule / ruleset. */
function handlersFor(req: DetailRequest, open: (r: DetailRequest) => void): On {
  const f = req.filter ?? {};
  const narrow: DetailFilter = f.ip ? { ip: f.ip } : f.rule ? { rule: f.rule } : f.ruleset ? { ruleset: f.ruleset } : {};
  return {
    ip: (ip) => open({ t: req.t, filter: { ...timeOf(f), ...shapeOf(f), ip } }),
    view: (view, label) => open({ t: req.t, filter: { ...timeOf(f), ...(f.ip ? { ip: f.ip } : {}), view, part: SECURITY_VIEWS.includes(view) ? 'security' : 'requests' }, label }),
    rule: (rule) => open({ t: req.t, filter: { ...timeOf(f), ...shapeOf(f), rule } }),
    ruleset: (ruleset) => open({ t: req.t, filter: { ...timeOf(f), ...shapeOf(f), ruleset } }),
    time: (alias, row) => {
      if (alias === 'daily') open({ t: req.t, filter: { ...narrow, ...shapeOf(f), day: row.dims.date }, focus: req.focus, label: req.label });
      else if (alias === 'hourly') open({ t: req.t, filter: { ...narrow, ...shapeOf(f), day: row.dims.datetimeHour.slice(0, 10), hour: Number(row.dims.datetimeHour.slice(11, 13)) }, focus: req.focus, label: req.label });
    },
  };
}

function titleOf(req: DetailRequest, d: ZoneDetail | null) {
  const f = req.filter ?? {};
  const who = d ? (d.zoneName ?? d.accountName) : req.t.zone ? 'Zone' : 'Account';
  const when = f.day ? `${dayLabel(f.day)}${f.hour !== undefined ? `, ${String(f.hour).padStart(2, '0')}:00–${String(f.hour + 1).padStart(2, '0')}:00 UTC` : ''}` : new Date(`${req.t.month}-01T00:00:00Z`).toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const what = f.ip ? `Client IP ${f.ip}` : f.ruleset ? `Ruleset “${d?.rulesetNames[f.ruleset] ?? MANAGED_RULESETS[f.ruleset] ?? f.ruleset}”`
    : f.rule ? `Rule “${d?.security.events.find((e) => e.ruleId === f.rule)?.description ?? f.rule}”` : req.label ?? 'All traffic';
  return { title: `${what} · ${who}`, when };
}

function DetailWindow({ req, onClose, onBack, open }: { req: DetailRequest; onClose: () => void; onBack?: () => void; open: (r: DetailRequest) => void }) {
  const f = req.filter && Object.keys(req.filter).length ? req.filter : null;
  const { d, pending, error, busy } = useDetail(req.t, f, 0);
  const on = handlersFor(req, open);
  const { title, when } = titleOf(req, d);
  const reqFirst = req.focus === 'requests';
  const security = d && f?.part !== 'requests' && (
    <section key="s">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><ShieldAlert className="size-4 text-signal" />Security events</h3>
      <SecurityBody d={d} on={on} />
    </section>
  );
  const requests = d && f?.part !== 'security' && d.requests.message !== 'Requests are not linked to rules' && (
    <section key="r">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Network className="size-4 text-signal" />Requests</h3>
      <RequestsBody d={d} on={on} />
    </section>
  );
  // Chips: what this window is narrowed to; each can be dropped.
  const chips: { label: string; drop: DetailFilter }[] = [];
  if (f?.day) chips.push({ label: dayLabel(f.day), drop: { ...f, day: undefined, hour: undefined } });
  if (f?.hour !== undefined) chips.push({ label: `Hour ${String(f.hour).padStart(2, '0')}:00`, drop: { ...f, hour: undefined } });
  if (f?.ip) chips.push({ label: `IP ${f.ip}`, drop: { ...f, ip: undefined } });
  if (f?.rule) chips.push({ label: 'This rule', drop: { ...f, rule: undefined } });
  if (f?.ruleset) chips.push({ label: 'This ruleset', drop: { ...f, ruleset: undefined } });
  if (f?.view) chips.push({ label: VIEW_LABEL[f.view], drop: { ...f, view: undefined } });
  if (f?.part) chips.push({ label: f.part === 'security' ? 'Security events only' : 'Requests only', drop: { ...f, part: undefined } });
  return (
    <Modal open onClose={onClose} width="max-w-6xl" title={title}
      description={`${when}${req.t.zone ? '' : ' · the account’s busiest zones added up'} — click any IP, rule, ruleset, day or hour to go deeper.`}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {onBack && <Button size="sm" variant="ghost" onClick={onBack} icon={<ArrowLeft className="size-3.5" />}>Back</Button>}
        {chips.map((c) => (
          <button key={c.label} type="button" onClick={() => open({ ...req, filter: Object.fromEntries(Object.entries(c.drop).filter(([, v]) => v !== undefined)) })}
            className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-raised px-2.5 py-0.5 text-xs text-ink-2 hover:border-faint hover:text-ink" title="Remove this">
            {c.label}<X className="size-3" />
          </button>
        ))}
      </div>
      {error && <Alert tone="bad" title="Could not be read">{error}</Alert>}
      {busy && !d && <Reading what={f?.hour !== undefined ? 'this hour' : f?.day ? 'this day' : f?.ip ? 'this IP' : f?.ruleset ? 'this ruleset' : f?.rule ? 'this rule' : f?.part === 'security' ? 'the security events' : f?.part === 'requests' ? 'the requests' : 'the details'} pending={pending} />}
      {d && <div className="space-y-10">{reqFirst ? [requests, security] : [security, requests]}</div>}
    </Modal>
  );
}

/** Holds the details window and its Back history; anything inside can open it with useOpenDetail(). */
export function DetailHost({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<DetailRequest[]>([]);
  const open = useCallback((r: DetailRequest) => setStack((s) => [...s, r]), []);
  const top = stack[stack.length - 1];
  return (
    <OpenCtx.Provider value={open}>
      {children}
      {top && <DetailWindow key={stack.length + JSON.stringify(top)} req={top} open={open} onClose={() => setStack([])} onBack={stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : undefined} />}
    </OpenCtx.Provider>
  );
}

// ── Exported: the security and request sections, below the monthly totals ──

export function ZoneDetailView({ month, account, zone }: Target) {
  const t = useMemo(() => ({ month, account, zone }), [month, account, zone]);
  const [refresh, setRefresh] = useState(0);
  const { d, pending, error, busy } = useDetail(t, null, refresh);
  const open = useOpenDetail();
  const [ipQuery, setIpQuery] = useState('');
  const on = useMemo(() => handlersFor({ t }, open), [t, open]);

  return (
    <>
      <Card>
        <SectionHeader title="Security events" description={`WAF and other security features on ${zone ? 'this zone' : 'the account\'s zones'}: which rules matched (managed, custom, rate limiting …), what they did, and which IPs triggered them. Click anything for its detail.`}
          aside={(
            <div className="flex items-center gap-2">
              <form className="hidden items-center gap-1 sm:flex" onSubmit={(e) => { e.preventDefault(); const ip = ipQuery.trim(); if (ip) on.ip(ip); }}>
                <label htmlFor={`traffic-ip-${zone ?? 'account'}`} className="sr-only">Look up an IP</label>
                <input id={`traffic-ip-${zone ?? 'account'}`} className="input h-8 w-40 text-xs" placeholder="Look up an IP…" value={ipQuery} onChange={(e) => setIpQuery(e.target.value)} />
                <Button type="submit" size="sm" variant="ghost" icon={<Search className="size-3.5" />} aria-label="Look up" />
              </form>
              <Button variant="ghost" size="sm" onClick={() => setRefresh((n) => n + 1)} disabled={busy} icon={<RefreshCw className="size-3.5" />}>Refresh</Button>
            </div>
          )} />
        <div className="p-5">
          {error && <Alert tone="bad" title="Security events could not be read">{error}</Alert>}
          {busy && !d && <Reading what="security events and requests" pending={pending} />}
          {d && <SecurityBody d={d} on={on} />}
        </div>
      </Card>
      <Card>
        <SectionHeader title="Requests" description={`All HTTP requests to ${zone ? 'this zone' : 'the account\'s zones'}: top client IPs, paths, hosts, status codes, cache status, networks, clients and single requests.`} />
        <div className="p-5">
          {busy && !d && <Reading what="requests" pending={pending} />}
          {d && <RequestsBody d={d} on={on} />}
          {d && <p className="mt-6 text-[11px] text-faint">Read live from Cloudflare {fmtDate(d.generatedAt)}</p>}
        </div>
      </Card>
    </>
  );
}
