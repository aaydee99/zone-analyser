'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RefreshCw, Search, ShieldAlert, Network } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import type { DatasetDetail, DetailFilter, DetailRow, FirewallEvent, ZoneDetail, ZoneDetailPending } from '@/lib/traffic-types';
import { Alert, Badge, Button, Card, Modal, SectionHeader, cx } from '@/components/ui';
import { bytes, dayLabel, num, pct, whole } from './format';

// One zone's security events and requests, read for the chosen zone only (see src/lib/traffic-security.ts).
// An IP or a rule opens the same view narrowed to it.

interface Target { month: string; account: string; zone: string }

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
  const qs = useMemo(() => new URLSearchParams({ month: t.month, account: t.account, zone: t.zone, ...(filter?.ip ? { ip: filter.ip } : {}), ...(filter?.rule ? { rule: filter.rule } : {}) }).toString(), [t.month, t.account, t.zone, filter?.ip, filter?.rule]);
  const lastRefresh = useRef(refresh);

  useEffect(() => {
    const mine = ++seq.current;
    const fresh = refresh !== lastRefresh.current;
    lastRefresh.current = refresh;
    setBusy(true); setError(''); setPending(null); setD(null);
    void (async () => {
      try {
        for (let first = true; ; first = false) {
          const r = await api<ZoneDetail | ZoneDetailPending>(`/api/traffic/detail?${qs}${fresh && first ? '&fresh=1' : ''}`);
          if (mine !== seq.current) return;
          if (!r || typeof r !== 'object') throw new Error('The console sent an empty answer');
          if (!('pending' in r)) {
            if (!r.security || !r.requests) throw new Error('The worker answered in an older format: it restarts with the new version once idle (or cancel its run in GitHub › Actions › Console worker).');
            setD(r); setPending(null);
            break;
          }
          setPending(r);
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          if (mine !== seq.current) return;
        }
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    })();
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
    </div>
  );
}

/** What was read, for how long Cloudflare keeps it, and anything left out. */
function Coverage({ ds }: { ds: DatasetDetail }) {
  if (!ds.available) return null;
  return (
    <div className="space-y-1 text-[11.5px] text-muted">
      <p>
        {ds.since && ds.until && <>Covers {fmtDate(ds.since)} – {fmtDate(ds.until)}</>}
        {ds.retentionDays !== null && <> · Cloudflare keeps this for {ds.retentionDays} days on this zone&apos;s plan</>}
        {ds.parts > 1 && <> · read in {ds.parts} parts (top lists are the best of each part)</>}
      </p>
      {ds.notes.map((n) => <p key={n} className="text-faint">{n}</p>)}
    </div>
  );
}

/** Events or requests per day: one series, with the exact number on hover. */
function PerDay({ rows, label }: { rows: DetailRow[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((r) => r.count));
  const h = hover !== null ? rows[hover] : null;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted"><span className="font-medium text-ink-2">{label} per day</span><span className="text-faint tabular-nums">{num(max)}</span></div>
      <div className="relative">
        <div className="flex h-24 items-end gap-0.5 border-b border-line-strong" onMouseLeave={() => setHover(null)}>
          {rows.map((r, i) => (
            <button key={r.dims.date} type="button" aria-label={`${dayLabel(r.dims.date)}: ${whole.format(r.count)}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              className={cx('flex h-full min-w-0 flex-1 items-end rounded-t-sm focus:outline-none', hover === i && 'bg-raised/60')}>
              <span className="w-full rounded-t-sm bg-signal" style={{ height: `${(r.count / max) * 100}%` }} />
            </button>
          ))}
        </div>
        {h && hover !== null && (
          <div className="pointer-events-none absolute bottom-full z-20 mb-1 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-xs shadow-pop"
            style={{ left: `${((hover + 0.5) / rows.length) * 100}%`, transform: `translateX(${hover < rows.length / 3 ? '-10%' : hover > (rows.length * 2) / 3 ? '-90%' : '-50%'})` }}>
            <span className="text-muted">{dayLabel(h.dims.date)}</span> <span className="tabular-nums text-ink">{whole.format(h.count)}</span>{h.bytes !== undefined && <span className="text-muted"> · {bytes(h.bytes)}</span>}
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-faint"><span>{dayLabel(rows[0].dims.date)}</span><span>{dayLabel(rows[rows.length - 1].dims.date)}</span></div>
    </div>
  );
}

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
                  <td className="px-3 py-2 text-right tabular-nums text-ink">{whole.format(r.count)}</td>
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
                <td className="px-3 py-2 text-right tabular-nums text-ink">{whole.format(r.count)}</td>
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
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 20);
  if (!events.length) return <p className="text-xs text-faint">No events in the newest part of the month.</p>;
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[980px] text-left text-[11.5px]">
          <thead className="bg-raised/50 text-muted"><tr>{['Time (UTC)', 'Action', 'Rule', 'Client', 'Request', 'Status', 'Ray ID'].map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
          <tbody className="align-top">
            {shown.map((e, i) => {
              const a = s(e.action);
              return (
                <tr key={`${s(e.rayName)}-${i}`} className="border-t border-line/50">
                  <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-ink-2">{s(e.datetime).replace('T', ' ').replace(/(\.\d+)?Z$/, '')}</td>
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
      {events.length > 20 && <button type="button" onClick={() => setAll(!all)} className="mt-2 text-xs text-muted hover:text-ink">{all ? 'Show fewer' : `Show all ${events.length} events`}</button>}
    </div>
  );
}

// ── The two sections ────────────────────────────────────────────────────────

function SecurityBody({ d, onIp, onRule }: { d: ZoneDetail; onIp: (ip: string) => void; onRule: (rule: string) => void }) {
  const s = d.security;
  if (!s.available) return <Alert tone="info">{s.message ?? 'Not available'}</Alert>;
  const b = s.breakdowns;
  return (
    <div className="space-y-6">
      <Coverage ds={s} />
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div><div className="eyebrow">Security events</div><div className="mt-1 text-[26px] font-semibold tabular-nums">{whole.format(s.total)}</div></div>
        <div className="flex flex-wrap gap-1.5">
          {(b.actions ?? []).map((r) => {
            const tone = actionTone(r.dims.action);
            return <Badge key={r.dims.action} tone={tone === 'neutral' ? 'neutral' : tone}>{actionLabel(r.dims.action)} · {num(r.count)}</Badge>;
          })}
        </div>
      </div>
      {b.daily && <PerDay rows={b.daily} label="Events" />}
      {b.rules && (
        <div>
          <div className="eyebrow mb-2">Rules that matched</div>
          <p className="mb-2 text-xs text-muted">Managed rules, custom rules, rate limiting and other security features — open a rule to see who triggered it.</p>
          <RulesTable rows={b.rules} names={d.rulesetNames} total={s.total} onPick={onRule} />
        </div>
      )}
      {b.ips && (
        <div>
          <div className="eyebrow mb-2">Top client IPs</div>
          <IpTable rows={b.ips} total={s.total} onPick={onIp} what="Events" />
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        <BarList title="By source" rows={b.sources} label={(r) => sourceLabel(r.dims.source)} total={s.total} />
        <BarList title="Paths" rows={b.paths} label={(r) => <span className="font-mono">{r.dims.clientRequestPath || '/'}</span>} total={s.total} />
        <BarList title="Hosts" rows={b.hosts} label={(r) => r.dims.clientRequestHTTPHost || '—'} total={s.total} />
        <BarList title="Countries" rows={b.countries} label={(r) => r.dims.clientCountryName || 'Unknown'} total={s.total} />
        <BarList title="Networks (ASN)" rows={b.asns} label={(r) => r.dims.clientASNDescription || `AS${r.dims.clientAsn}`} sub={(r) => (r.dims.clientAsn ? `AS${r.dims.clientAsn}` : '')} total={s.total} />
        <BarList title="HTTP methods" rows={b.methods} label={(r) => r.dims.clientRequestHTTPMethodName || '—'} total={s.total} />
      </div>
      <BarList title="User agents" rows={b.userAgents} label={(r) => <span className="font-mono text-[11px]">{r.dims.userAgent || '(none)'}</span>} total={s.total} />
      <div>
        <div className="eyebrow mb-2">Latest events</div>
        {s.eventsSince && <p className="mb-2 text-xs text-muted">The newest {s.events.length} events since {fmtDate(s.eventsSince)}.</p>}
        <EventsTable events={s.events} names={d.rulesetNames} onIp={onIp} onRule={onRule} />
      </div>
    </div>
  );
}

function RequestsBody({ d, onIp }: { d: ZoneDetail; onIp: (ip: string) => void }) {
  const q = d.requests;
  if (!q.available) return <Alert tone="info">{q.message ?? 'Not available'}</Alert>;
  const b = q.breakdowns;
  const totalBytes = (b.daily ?? []).reduce((n, r) => n + (r.bytes ?? 0), 0);
  return (
    <div className="space-y-6">
      <Coverage ds={q} />
      <div className="flex flex-wrap gap-x-8 gap-y-2">
        <div><div className="eyebrow">Requests</div><div className="mt-1 text-[26px] font-semibold tabular-nums">{whole.format(q.total)}</div></div>
        {totalBytes > 0 && <div><div className="eyebrow">Bandwidth</div><div className="mt-1 text-[26px] font-semibold tabular-nums">{bytes(totalBytes)}</div></div>}
      </div>
      {b.daily && <PerDay rows={b.daily} label="Requests" />}
      {b.ips && (
        <div>
          <div className="eyebrow mb-2">Top client IPs</div>
          <IpTable rows={b.ips} total={q.total} withBytes onPick={onIp} what="Requests" />
        </div>
      )}
      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
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
    </div>
  );
}

/** An IP or a rule, narrowed: what it did / who triggered it. */
function DrillModal({ t, filter, onClose, onFilter }: { t: Target; filter: DetailFilter; onClose: () => void; onFilter: (f: DetailFilter) => void }) {
  const { d, pending, error, busy } = useDetail(t, filter, 0);
  const ruleName = d?.security.events.find((e) => e.ruleId === filter.rule)?.description;
  const title = filter.ip ? `Client IP ${filter.ip}` : `Rule ${ruleName ? `“${ruleName}”` : filter.rule}`;
  return (
    <Modal open onClose={onClose} width="max-w-6xl" title={title}
      description={filter.ip ? 'Everything this IP did on the zone this month: rules it triggered, actions taken, paths and requests.' : `Who triggered this rule and where. Rule ID ${filter.rule}.`}>
      {error && <Alert tone="bad" title="Could not be read">{error}</Alert>}
      {busy && !d && <Reading what={filter.ip ? 'this IP' : 'this rule'} pending={pending} />}
      {d && (
        <div className="space-y-8">
          <section>
            <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><ShieldAlert className="size-4 text-signal" />Security events</h3>
            <SecurityBody d={d} onIp={(ip) => onFilter({ ip })} onRule={(rule) => onFilter({ rule })} />
          </section>
          {filter.ip && (
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Network className="size-4 text-signal" />Requests</h3>
              <RequestsBody d={d} onIp={() => { /* already this IP */ }} />
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

// ── Exported: the zone's detail, below its monthly totals ───────────────────

export function ZoneDetailView({ month, account, zone }: Target) {
  const t = useMemo(() => ({ month, account, zone }), [month, account, zone]);
  const [refresh, setRefresh] = useState(0);
  const { d, pending, error, busy } = useDetail(t, null, refresh);
  const [drill, setDrill] = useState<DetailFilter | null>(null);
  const [ipQuery, setIpQuery] = useState('');
  const onIp = useCallback((ip: string) => setDrill({ ip }), []);
  const onRule = useCallback((rule: string) => setDrill({ rule }), []);

  return (
    <>
      <Card>
        <SectionHeader title="Security events" description="WAF and other security features on this zone: which rules matched (managed, custom, rate limiting …), what they did, and which IPs triggered them."
          aside={(
            <div className="flex items-center gap-2">
              <form className="hidden items-center gap-1 sm:flex" onSubmit={(e) => { e.preventDefault(); const ip = ipQuery.trim(); if (ip) setDrill({ ip }); }}>
                <label htmlFor="traffic-ip" className="sr-only">Look up an IP</label>
                <input id="traffic-ip" className="input h-8 w-40 text-xs" placeholder="Look up an IP…" value={ipQuery} onChange={(e) => setIpQuery(e.target.value)} />
                <Button type="submit" size="sm" variant="ghost" icon={<Search className="size-3.5" />} aria-label="Look up" />
              </form>
              <Button variant="ghost" size="sm" onClick={() => setRefresh((n) => n + 1)} disabled={busy} icon={<RefreshCw className="size-3.5" />}>Refresh</Button>
            </div>
          )} />
        <div className="p-5">
          {error && <Alert tone="bad" title="Security events could not be read">{error}</Alert>}
          {busy && !d && <Reading what="security events and requests" pending={pending} />}
          {d && <SecurityBody d={d} onIp={onIp} onRule={onRule} />}
        </div>
      </Card>
      <Card>
        <SectionHeader title="Requests" description="All HTTP requests to this zone: top client IPs, paths, hosts, status codes, cache status, networks and clients." />
        <div className="p-5">
          {busy && !d && <Reading what="requests" pending={pending} />}
          {d && <RequestsBody d={d} onIp={onIp} />}
          {d && <p className="mt-6 text-[11px] text-faint">Read {fmtDate(d.generatedAt)}{d.cachedIn ? ' (cached — Refresh reads again)' : ''}</p>}
        </div>
      </Card>
      {drill && <DrillModal key={JSON.stringify(drill)} t={t} filter={drill} onClose={() => setDrill(null)} onFilter={setDrill} />}
    </>
  );
}
