'use client';

import { compactNum } from '@/lib/num';
import { isValidElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Download, FileJson, Globe, History, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { fmtDate } from '@/lib/client';
import { DEFAULT_CIPHERS, type ZoneGroupReport, type ZoneRulePhase, type ZoneSection, type ZoneSummary } from '@/lib/zone-catalog';
import { MANAGED_RULESETS } from '@/lib/traffic-types';
import { deployOf, tuningLines, tuningOf } from '@/lib/waf-labels';
import { actionDetail, certificatesOf, daysLeft, isExpired, isObj, ruleScope, rulesByHost, text, type CertRow, type RuleScope, type ScopedRule } from '@/lib/zone-format';
import { Alert, Badge, Button, ButtonLink, Card, Loading, Skeleton, SkeletonStats, SkeletonText, Stat, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { FavouriteStar } from '@/components/quick-zones';
import { useZoneStore } from '@/lib/stores/zone-store';
import type { ZoneMeta } from '@/lib/zone-meta-types';
import { ZoneMetaPanel } from './zone-meta-panel';

const ROWS = 300;
/** Columns worth showing first for a list of objects. */
const PREFERRED = ['name', 'description', 'hostname', 'type', 'pattern', 'expression', 'action', 'mode', 'status', 'enabled', 'paused', 'value', 'content', 'priority', 'id'];

/** Every field of an object as path → value (nested objects flattened: "a.b", lists of objects "a[0].b"). */
function fields(v: unknown, path = '', out: [string, unknown][] = []): [string, unknown][] {
  if (Array.isArray(v) && v.some(isObj)) { v.forEach((x, i) => fields(x, `${path}[${i}]`, out)); return out; }
  if (isObj(v) && Object.keys(v).length) { for (const [k, x] of Object.entries(v)) fields(x, path ? `${path}.${k}` : k, out); return out; }
  out.push([path || 'value', v]);
  return out;
}

/** A setting's value in words: Cloudflare answers an empty list for ciphers when the zone uses its default cipher suites. */
function settingValue(id: unknown, v: unknown): unknown {
  if (id === 'ciphers' && Array.isArray(v)) {
    return v.length ? v.join(', ')
      : [`Cloudflare default (Legacy): no suites chosen, so every suite below can be used, from the minimum TLS version up`, ...DEFAULT_CIPHERS.map((c) => `${c.protocol}: ${c.suites.join(', ')}`)].join('\n');
  }
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object')) return v.length ? v.join(', ') : '(empty list)';
  if (isObj(v)) return fields(v).map(([k, x]) => `${k}: ${text(x) || '—'}`).join('\n');
  return v;
}

function Cell({ v }: { v: unknown }) {
  if (isValidElement(v)) return v;
  if (typeof v === 'boolean') return <Badge tone={v ? 'ok' : 'neutral'}>{v ? 'on' : 'off'}</Badge>;
  const s = text(v);
  return <span className={cx('break-words whitespace-pre-wrap [overflow-wrap:anywhere]', !s && 'text-faint')}>{s || '—'}</span>;
}

/** Rows of a table; with `details`, each row opens every field of its object. */
function Table({ head, rows, details }: { head: string[]; rows: unknown[][]; details?: Record<string, unknown>[] }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const shown = all ? rows : rows.slice(0, ROWS);
  const flip = (i: number) => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const width = head.length + (details ? 1 : 0);
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[520px] text-left text-[12px]">
        <thead className="bg-raised/50 text-muted"><tr>{head.map((h) => <th key={h} className="px-3 py-1.5 font-medium whitespace-nowrap">{h}</th>)}{details && <th className="px-3 py-1.5 font-medium whitespace-nowrap">All fields</th>}</tr></thead>
        <tbody className="font-mono">
          {shown.map((r, i) => {
            const f = details ? fields(details[i]) : [];
            return [
              <tr key={i} className="border-t border-line/50 align-top">
                {r.map((c, j) => <td key={j} className="max-w-[28rem] px-3 py-1.5"><Cell v={c} /></td>)}
                {details && <td className="px-3 py-1.5 whitespace-nowrap"><button type="button" aria-expanded={open.has(i)} onClick={() => flip(i)} className="font-sans text-[11.5px] text-muted hover:text-ink">{open.has(i) ? 'Hide' : `Show all ${f.length.toLocaleString('en-US')}`}</button></td>}
              </tr>,
              details && open.has(i) && (
                <tr key={`${i}-all`} className="bg-sunken/40">
                  <td colSpan={width} className="px-3 py-2">
                    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(10rem,max-content)_minmax(0,1fr)]">
                      {f.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted break-all">{k}</dt><dd className="min-w-0"><Cell v={v} /></dd></div>)}
                    </dl>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
      {rows.length > ROWS && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-line/50 px-3 py-1.5 text-left text-xs text-muted hover:text-ink">
          {all ? 'Show fewer' : `Show all ${rows.length.toLocaleString('en-US')} rows`}
        </button>
      )}
    </div>
  );
}

/** A readable view of one section: settings and DNS get their own tables; other lists and objects a generic one, each row opening all its fields. */
function SectionBody({ s }: { s: ZoneSection }) {
  const d = s.data;
  if (s.key.startsWith('settings:') && Array.isArray(d)) {
    return <Table head={['Setting', 'Value', 'Editable', 'Modified']} rows={(d as Record<string, unknown>[]).map((x) => [x.id, settingValue(x.id, x.value), x.editable, x.modified_on ? fmtDate(String(x.modified_on)) : ''])} />;
  }
  if (s.key === 'dns_records' && Array.isArray(d)) {
    const recs = d as Record<string, unknown>[];
    return <Table head={['Type', 'Name', 'Content', 'Proxied', 'TTL', 'Priority', 'Comment']} rows={recs.map((x) => [x.type, x.name, x.content, x.proxied, x.ttl === 1 ? 'auto' : x.ttl, x.priority, x.comment])} details={recs} />;
  }
  if (Array.isArray(d)) {
    const objs = d.filter(isObj);
    if (objs.length !== d.length) return <Table head={['Value']} rows={d.map((x) => [x])} />;
    const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))];
    const cols = [...PREFERRED.filter((k) => keys.includes(k)), ...keys.filter((k) => !PREFERRED.includes(k))].slice(0, 7);
    return <Table head={cols} rows={objs.map((o) => cols.map((k) => (isObj(o[k]) || Array.isArray(o[k]) ? settingValue('', o[k]) : o[k])))} details={keys.length > cols.length || objs.some((o) => Object.values(o).some((v) => isObj(v) || Array.isArray(v))) ? objs : undefined} />;
  }
  if (isObj(d)) return <Table head={['Field', 'Value']} rows={fields(d).map(([k, v]) => [k, Array.isArray(v) ? settingValue('', v) : v])} />;
  return <p className="font-mono text-[12px] break-all text-ink-2">{text(d)}</p>;
}

function SectionView({ s, open }: { s: ZoneSection; open: boolean }) {
  const [json, setJson] = useState(false);
  return (
    <details open={open} className="group/s border-t border-line/50 first:border-0">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-5 py-2.5 hover:bg-raised/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-open/s:rotate-90" aria-hidden />
        <span className="text-[13px] font-medium">{s.label}</span>
        <span className="font-mono text-[11px] text-faint">GET {s.path}</span>
        <span className="ml-auto flex items-center gap-2">
          {s.truncated && <Badge tone="warn">first {(s.count === undefined ? undefined : compactNum(s.count))}</Badge>}
          {s.count !== undefined && <Badge>{compactNum(s.count)}</Badge>}
        </span>
      </summary>
      <div className="space-y-2 px-5 pb-4">
        <SectionBody s={s} />
        {s.message && <p className="text-xs text-warn">{s.message}</p>}
        <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => setJson(!json)}>{json ? 'Hide JSON' : 'Show JSON'}</button>
        {json && <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-raised/40 p-3 font-mono text-[11px] break-all whitespace-pre-wrap text-ink-2">{JSON.stringify(s.data, null, 2)}</pre>}
      </div>
    </details>
  );
}

/** Applies to: "Whole zone", "Zone apex", or the hostnames / host patterns the rule is limited to. */
function Scope({ s, zone }: { s: RuleScope; zone: string }) {
  if (!s.hosts.length && !s.patterns.length) return <Badge>Whole zone</Badge>;
  return (
    <span className="flex flex-col items-start gap-1">
      {s.hosts.map((h) => <Badge key={h} tone={h === zone.toLowerCase() ? 'info' : 'signal'}>{h === zone.toLowerCase() ? `${h} (apex)` : h}</Badge>)}
      {s.patterns.map((p) => <Badge key={p} tone="warn">host {p}</Badge>)}
    </span>
  );
}

/** A section's rule pages (as the dashboard lists them): each phase's rules in order. */
/** A rule that runs a ruleset: its name (with the rule's own description, if any), its settings, and what it changes. */
function rulesetCells(r: Record<string, unknown>, names: Record<string, string>): { name: ReactNode; action: ReactNode; detail: ReactNode } | null {
  const d = deployOf(r);
  if (!d) return null;
  const t = tuningOf(d, names);
  const own = text(r.description);
  return {
    name: <span><span className="font-medium text-ink">{t.name}</span>{own && own !== t.name && <span className="block text-[11px] text-muted">{own}</span>}</span>,
    action: (
      <dl className="space-y-0.5 text-[12px]">
        {tuningLines(t).map(([k, v]) => <div key={k}><dt className="inline text-muted">{k}: </dt><dd className="inline text-ink-2">{v}</dd></div>)}
      </dl>
    ),
    detail: (
      <span className="text-[12px]">
        Runs {t.name}.
        {t.overrides.length ? <ul className="mt-0.5 list-disc pl-4">{t.overrides.map((o) => <li key={o}>{o}</li>)}</ul> : <span className="block text-muted">No rule or category changed.</span>}
      </span>
    ),
  };
}

function RulePages({ pages, names, find, zone }: { pages: ZoneRulePhase[]; names: Record<string, string>; find: string; zone: string }) {
  const q = find.trim().toLowerCase();
  const hit = (p: ZoneRulePhase, r: Record<string, unknown>) => !q || p.label.toLowerCase().includes(q) || JSON.stringify(r).toLowerCase().includes(q);
  return (
    <>
      {pages.map((p) => {
        const rules = p.rules.filter((r) => hit(p, r));
        return (
          <details key={p.phase} open={!!q || (p.status === 'ok' && p.rules.length <= 10)} className="group/s border-t border-line/50 first:border-0">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-5 py-2.5 hover:bg-raised/40 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-open/s:rotate-90" aria-hidden />
              <span className="text-[13px] font-medium">{p.label}</span>
              <span className="font-mono text-[11px] text-faint">{p.phase}</span>
              <span className="ml-auto">
                {p.status === 'ok' ? <Badge tone="signal">{compactNum(p.rules.length)} rule{p.rules.length === 1 ? '' : 's'}</Badge>
                  : p.status === 'empty' ? <Badge>none</Badge> : <Badge tone="warn">not readable</Badge>}
              </span>
            </summary>
            <div className="px-5 pb-4">
              {p.status === 'ok' ? (
                <>
                  <Table head={['#', 'Name', 'Applies to', 'Match (expression)', 'Action', 'What it does', 'Enabled']}
                    rows={rules.map((r) => {
                      const rs = rulesetCells(r, names);
                      return [p.rules.indexOf(r) + 1, rs?.name ?? (r.description || r.ref || r.id), <Scope key="s" s={ruleScope(r.expression)} zone={zone} />, r.expression, rs?.action ?? r.action, rs?.detail ?? actionDetail(r, names), r.enabled !== false];
                    })} details={rules} />
                  <p className="mt-1.5 text-xs text-faint">Ruleset {p.rulesetId}{p.version ? ` · version ${p.version}` : ''}{p.lastUpdated ? ` · updated ${fmtDate(p.lastUpdated)}` : ''}</p>
                </>
              ) : (
                <p className="text-xs text-muted">{p.status === 'empty' ? 'No rules configured.' : p.message}</p>
              )}
            </div>
          </details>
        );
      })}
    </>
  );
}

/** Every certificate of the zone: Cloudflare managed or custom, issuer, status and expiry, soonest first. */
function Certificates({ certs, find }: { certs: CertRow[]; find: string }) {
  const q = find.trim().toLowerCase();
  const shown = q ? certs.filter((c) => [c.hosts, c.managedBy, c.kind, c.issuer, c.status, c.source, 'certificate'].some((x) => x.toLowerCase().includes(q))) : certs;
  if (q && !shown.length) return null;
  const now = Date.now();
  const expired = certs.filter((c) => isExpired(c.expiresOn, now)).length;
  const soon = certs.filter((c) => { const d = daysLeft(c.expiresOn, now); return !isExpired(c.expiresOn, now) && d !== null && d <= 30; }).length;
  return (
    <details open className="group/s border-t border-line/50 first:border-0">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-5 py-2.5 hover:bg-raised/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-open/s:rotate-90" aria-hidden />
        <span className="text-[13px] font-medium">Certificates</span>
        <span className="text-[11px] text-faint">every certificate, soonest expiry first</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {expired > 0 && <Badge tone="bad">{expired} expired</Badge>}
          {soon > 0 && <Badge tone="warn">{soon} expire{soon === 1 ? 's' : ''} within 30 days</Badge>}
          <Badge>{certs.length}</Badge>
        </span>
      </summary>
      <div className="px-5 pb-4">
        {!certs.length ? <p className="text-xs text-muted">No certificates are listed for this zone (or the token cannot read the certificate endpoints).</p> : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[820px] text-left text-[12px]">
              <thead className="bg-raised/50 text-muted">
                <tr>{['Hosts', 'Expires', 'Days left', 'Managed by', 'Type', 'Issuer', 'Status'].map((h) => <th key={h} className="px-3 py-1.5 font-medium whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {shown.map((c, i) => {
                  const d = daysLeft(c.expiresOn, now);
                  const gone = isExpired(c.expiresOn, now);
                  return (
                    <tr key={`${c.source}:${c.id}:${i}`} className="border-t border-line/50 align-top">
                      <td className="min-w-[190px] px-3 py-1.5 font-mono">
                        {c.hosts ? c.hosts.split(', ').map((h) => <div key={h} className="break-words">{h}</div>) : <span className="text-faint">—</span>}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{c.expiresOn ? fmtDay(c.expiresOn) : <span className="text-faint">not issued yet</span>}</td>
                      <td className={cx('px-3 py-1.5 whitespace-nowrap tabular-nums', d === null ? 'text-faint' : gone ? 'font-medium text-bad' : d <= 30 ? 'font-medium text-warn' : 'text-ink-2')}>
                        {d === null ? '—' : gone ? (d === 0 ? 'expired today' : `expired ${-d} day${d === -1 ? '' : 's'} ago`) : `${d} day${d === 1 ? '' : 's'}`}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap"><Badge tone={c.managedBy === 'Custom' ? 'info' : 'signal'}>{c.managedBy}</Badge></td>
                      <td className="min-w-[170px] px-3 py-1.5">{c.kind}<div className="text-[11px] text-faint">{c.source}</div></td>
                      <td className="px-3 py-1.5">{c.issuer || '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{c.status || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

/** One group of rules (whole zone, the apex, one hostname or host pattern) as a table. */
function HostGroup({ title, note, badges, rules, open }: { title: ReactNode; note: string; badges?: ReactNode; rules: ScopedRule[]; open: boolean }) {
  return (
    <details open={open} className="group/s border-t border-line/50 first:border-0">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-5 py-2.5 hover:bg-raised/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-open/s:rotate-90" aria-hidden />
        <span className="font-mono text-[13px] font-medium break-all">{title}</span>
        <span className="text-[11px] text-faint">{note}</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">{badges}<Badge tone="signal">{compactNum(rules.length)} rule{rules.length === 1 ? '' : 's'}</Badge></span>
      </summary>
      <div className="px-5 pb-4">
        <Table head={['Rule page', '#', 'Name', 'Match', 'Action', 'What it does', 'Enabled']}
          rows={rules.map((r) => [r.page, r.n, r.name, r.match, r.action, r.detail, r.enabled])} />
      </div>
    </details>
  );
}

/** Every rule grouped by the hostnames it runs on: the whole zone, the apex, and each hostname with rules of its own. */
function RulesByHost({ zone, pages, sections, names, find }: { zone: string; pages: ZoneRulePhase[]; sections: ZoneSection[]; names: Record<string, string>; find: string }) {
  const all = useMemo(() => rulesByHost(zone, pages, sections, names), [zone, pages, sections, names]);
  const q = find.trim().toLowerCase();
  const keep = (rs: ScopedRule[], label = '') => (!q || label.toLowerCase().includes(q) ? rs : rs.filter((r) => [r.page, r.name, r.match, r.action, r.detail].some((x) => x.toLowerCase().includes(q))));
  const wide = keep(all.zoneWide, 'whole zone');
  const apex = keep(all.apex, zone);
  const hosts = all.hosts.map((h) => ({ ...h, rules: keep(h.rules, h.host) })).filter((h) => h.rules.length);
  const patterns = all.patterns.map((p) => ({ ...p, rules: keep(p.rules, p.pattern) })).filter((p) => p.rules.length);
  const total = all.zoneWide.length + all.apex.length + all.hosts.length + all.patterns.length;
  if (!total || (q && !wide.length && !apex.length && !hosts.length && !patterns.length)) return null;
  const dnsRead = sections.some((s) => s.key === 'dns_records' && s.status !== 'unavailable' && s.status !== 'error');
  return (
    <Card className="mb-4">
      <h2 className="flex flex-wrap items-center gap-x-2 border-b border-line px-5 py-3 text-[14px] font-semibold">
        Rules by hostname
        <span className="text-xs font-normal text-muted">which rules run on every host of {zone}, and which only on one hostname</span>
      </h2>
      <div className="flex flex-wrap gap-2 border-b border-line/50 px-5 py-3 text-[12px]">
        <span className="rounded-md border border-line px-2 py-1"><span className="text-muted">Whole zone</span> <b className="tabular-nums">{compactNum(all.zoneWide.length)}</b></span>
        {all.apex.length > 0 && <span className="rounded-md border border-line px-2 py-1"><span className="text-muted">{zone} only</span> <b className="tabular-nums">{compactNum(all.apex.length)}</b></span>}
        {all.hosts.map((h) => <span key={h.host} className="rounded-md border border-signal/40 bg-signal/5 px-2 py-1 font-mono"><span className="text-ink-2">{h.host}</span> <b className="tabular-nums">{compactNum(h.rules.length)}</b></span>)}
        {all.patterns.map((p) => <span key={p.pattern} className="rounded-md border border-warn/40 px-2 py-1 font-mono"><span className="text-ink-2">host {p.pattern}</span> <b className="tabular-nums">{compactNum(p.rules.length)}</b></span>)}
      </div>
      {wide.length > 0 && <HostGroup title="Whole zone" note={`no host condition: runs on ${zone} and every subdomain`} rules={wide} open={!!q} />}
      {apex.length > 0 && <HostGroup title={zone} note="limited to the zone apex" badges={<Badge tone="info">apex only</Badge>} rules={apex} open={!!q} />}
      {hosts.map((h) => (
        <HostGroup key={h.host} title={h.host} note={`rules for ${h.host} only, on top of the whole-zone rules`} rules={h.rules} open
          badges={<>
            <Badge tone="signal">host-specific</Badge>
            {dnsRead && (!h.inDns ? <Badge tone="warn">no DNS record</Badge> : !h.proxied ? <Badge tone="warn">DNS only: rules do not run</Badge> : <Badge tone="ok">proxied</Badge>)}
          </>} />
      ))}
      {patterns.map((p) => <HostGroup key={p.pattern} title={`host ${p.pattern}`} note="limited by a host pattern, not one exact hostname" badges={<Badge tone="warn">host pattern</Badge>} rules={p.rules} open={!!q} />)}
      {!q && all.otherDnsHosts.length > 0 && (
        <p className="border-t border-line/50 px-5 py-3 text-[12px] text-muted">
          No rules of their own (only the whole-zone rules{all.patterns.length ? ' and any matching host pattern' : ''} apply):{' '}
          {all.otherDnsHosts.map((h, i) => <span key={h.host} className="font-mono text-ink-2">{i ? ', ' : ''}{h.host}{h.proxied ? '' : ' (DNS only)'}</span>)}
        </p>
      )}
    </Card>
  );
}

/** A date without the time (certificates expire on a day). */
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Saves a download endpoint's answer as a file (the endpoint names it). */
async function download(url: string, fallbackName: string) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

const cacheNote = (p: { cachedIn?: string }) => (p.cachedIn ? ` · from the cache${p.cachedIn === 'redis' ? ' (Redis)' : ''}` : '');

/**
 * One zone, as the Zone explorer shows it: summary, downloads, tags, and every section. The data
 * comes from the zone store (stores/zone-store.ts), so the page, the zone panel and any view that
 * opened the zone share it; "Read again" and a section's ↻ read it again into the store.
 */
export function ZoneView({ zoneId, onPickTag, onMetaSaved, explorerLink = false }: {
  zoneId: string; onPickTag?: (t: string) => void; onMetaSaved?: (m: ZoneMeta) => void; explorerLink?: boolean;
}) {
  const toast = useToast();
  const entry = useZoneStore((s) => s.zones[zoneId]);
  const openZone = useZoneStore((s) => s.openZone);
  const refreshPart = useZoneStore((s) => s.refreshPart);
  const summary = entry?.summary ?? null;
  const parts = useMemo(() => entry?.parts ?? {}, [entry?.parts]);
  const loading = entry?.loading ?? true;
  const error = entry?.error ?? '';
  const [find, setFind] = useState('');
  const [saving, setSaving] = useState('');
  const openMeta = useZoneStore((s) => s.zoneMeta[zoneId]) ?? null;
  const loadZoneMeta = useZoneStore((s) => s.loadZoneMeta);
  const setZoneMeta = useZoneStore((s) => s.setZoneMeta);
  // Shown from the store; read only when it is not there yet (Read again reads it on purpose).
  useEffect(() => { if (zoneId) void openZone(zoneId); }, [zoneId, openZone]);
  // The zone's full tags, owner, contact and notes: from the store too.
  useEffect(() => { if (zoneId) void loadZoneMeta(zoneId); }, [zoneId, loadZoneMeta]);
  const pickTag = (t: string) => onPickTag?.(t);

  const loaded = useMemo(() => (summary?.sections ?? []).map((x) => parts[x.key]?.data).filter((x): x is ZoneGroupReport => !!x), [summary, parts]);
  const allSections = useMemo(() => loaded.flatMap((p) => p.sections), [loaded]);
  const allRules = useMemo(() => loaded.flatMap((p) => p.rules), [loaded]);
  // Cloudflare's managed rulesets are named even when the zone's ruleset list is not readable.
  const names = useMemo(() => Object.assign({ ...MANAGED_RULESETS }, ...loaded.map((p) => p.rulesetNames)) as Record<string, string>, [loaded]);
  const sections = useMemo(() => {
    const s = find.trim().toLowerCase();
    return s ? allSections.filter((x) => x.label.toLowerCase().includes(s) || x.path.includes(s) || JSON.stringify(x.data ?? '').toLowerCase().includes(s)) : allSections;
  }, [allSections, find]);
  const readable = sections.filter((s) => s.status === 'ok');
  const empty = sections.filter((s) => s.status === 'empty');
  const missing = sections.filter((s) => s.status === 'unavailable' || s.status === 'error');
  const dns = allSections.find((s) => s.key === 'dns_records');
  const oldest = loaded.map((p) => p.generatedAt).sort()[0];
  const cachedParts = loaded.filter((p) => p.cachedIn);
  const pending = Object.values(parts).filter((p) => p.state === 'loading').length;
  const sslPart = parts.ssl?.data;
  const certs = useMemo(() => (sslPart ? certificatesOf(sslPart.sections) : null), [sslPart]);
  const certSoon = certs?.filter((c) => { const d = daysLeft(c.expiresOn); return d !== null && d <= 30; }).length ?? 0;

  const save = async (what: keyof ZoneSummary['downloads'] & string, fallback: string) => {
    if (!summary) return;
    setSaving(what);
    try { await download(summary.downloads[what], fallback); } catch (e) { toast((e as Error).message, 'bad'); } finally { setSaving(''); }
  };
  const zoneName = summary?.zone.name ?? '';

  return (
    <>
    {error && <div className="mb-4"><Alert tone="bad" title="Could not read the zone">{error}</Alert></div>}
    {!summary && loading && (
      <Loading label="Opening the zone">
        <Card className="mb-4 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-2"><Skeleton className="h-5 w-48" /><Skeleton className="h-3 w-64" /></div>
            <div className="flex gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-20" />)}</div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
            {Array.from({ length: 9 }, (_, i) => <div key={i} className="space-y-1.5"><Skeleton className="h-2.5 w-16" /><Skeleton className="h-3 w-28" /></div>)}
          </div>
        </Card>
        <SkeletonStats count={5} className="mb-4 sm:!grid-cols-3 md:!grid-cols-3 xl:!grid-cols-5" />
      </Loading>
    )}
    {summary && (
      <>
        <Card className="mb-4 px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold break-words">{zoneName}</h2>
              <p className="mt-0.5 font-mono text-[11.5px] break-all text-muted">{summary.zone.id}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <FavouriteStar zoneId={summary.zone.id} zoneName={zoneName} />
              <Button size="sm" icon={<RefreshCw className={cx('size-3.5', loading && 'animate-spin')} />} onClick={() => { void openZone(summary.zone.id, true); void loadZoneMeta(summary.zone.id, true); }} disabled={loading}>Read again</Button>
              {explorerLink && <ButtonLink size="sm" variant="ghost" href={`/console/zone-explorer?zone=${encodeURIComponent(summary.zone.id)}`} icon={<Globe className="size-3.5" />}>Open in Zone explorer</ButtonLink>}
              <Button size="sm" icon={<FileJson className="size-3.5" />} loading={saving === 'json'} disabled={loading} onClick={() => save('json', `${zoneName}-cloudflare.json`)}>JSON</Button>
              <Button size="sm" icon={<Download className="size-3.5" />} loading={saving === 'csv'} disabled={loading} title="All configuration: one row per value" onClick={() => save('csv', `${zoneName}-cloudflare.csv`)}>All as CSV</Button>
              <Button size="sm" icon={<Download className="size-3.5" />} loading={saving === 'dnsCsv'} disabled={!Array.isArray(dns?.data) || !dns.data.length} onClick={() => save('dnsCsv', `${zoneName}-dns.csv`)}>DNS CSV</Button>
              <Button size="sm" icon={<Download className="size-3.5" />} loading={saving === 'bind'} disabled={dns?.status !== 'ok'} onClick={() => save('bind', `${zoneName}.txt`)}>BIND file</Button>
              <ButtonLink size="sm" variant="ghost" href={`/console/investigate/timeline?zone=${encodeURIComponent(summary.zone.id)}`} icon={<History className="size-3.5" />}>Timeline</ButtonLink>
              <ButtonLink size="sm" variant="ghost" href={`/console/security-audit?zone=${encodeURIComponent(summary.zone.id)}`} icon={<ShieldCheck className="size-3.5" />}>Security audit</ButtonLink>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-3">
            {([
              ['Account', summary.zone.accountName || summary.zone.accountId],
              ['Status', `${summary.zone.status}${summary.zone.paused ? ' (paused)' : ''}`],
              ['Plan', summary.zone.plan],
              ['Type', summary.zone.type],
              ['Name servers', summary.zone.nameServers.join(', ')],
              ['Created', summary.zone.createdOn ? fmtDate(summary.zone.createdOn) : '—'],
              ['Activated', summary.zone.activatedOn ? fmtDate(summary.zone.activatedOn) : '—'],
              ['Read with', summary.credentialName],
              ['Read at', pending ? `reading ${pending} section${pending === 1 ? '' : 's'}…` : oldest
                ? `${fmtDate(oldest)}${cachedParts.length ? ` · ${cachedParts.length === loaded.length ? 'from the cache' : `${cachedParts.length} sections from the cache`}${cachedParts[0].cachedIn === 'redis' ? ' (Redis)' : ''} — Read again for live data` : ''}` : '—'],
            ] as const).map(([k, v]) => (
              <div key={k} className="min-w-0"><dt className="text-xs text-muted">{k}</dt><dd className="break-words text-ink-2">{v || '—'}</dd></div>
            ))}
          </dl>
          <ZoneMetaPanel zoneId={summary.zone.id} zoneName={zoneName} meta={openMeta} onPickTag={pickTag}
            onSaved={(m) => { setZoneMeta(m); onMetaSaved?.(m); }} />
        </Card>

        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <Stat label="Sections read" value={allSections.filter((s) => s.status === 'ok').length} sub={`of ${allSections.length} endpoints`} />
          <Stat label="DNS records" value={(dns?.count === undefined ? undefined : compactNum(dns?.count)) ?? '—'} sub={dns?.truncated ? 'first ones only' : ' '} />
          <Stat label="Rules" value={allRules.reduce((n, p) => n + p.rules.length, 0)} sub={`on ${allRules.filter((p) => p.rules.length).length} rule pages`} />
          <Stat label="Certificates" value={certs?.length ?? '—'} tone={certSoon ? 'warn' : undefined} sub={certs ? (certSoon ? `${certSoon} expired or expiring within 30 days` : 'none expiring within 30 days') : 'reading…'} />
          <Stat label="Not readable" value={allSections.filter((s) => s.status === 'unavailable' || s.status === 'error').length} sub="token permission or plan" />
        </div>

        <label className="relative mb-4 block">
          <span className="sr-only">Find in this zone</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input className="input !pl-9" placeholder="Find a setting, record, value…" value={find} onChange={(e) => setFind(e.target.value)} />
        </label>

        <RulesByHost zone={zoneName} pages={allRules} sections={allSections} names={names} find={find} />

        {summary.sections.map((g) => {
          const part = parts[g.key];
          const head = (extra?: ReactNode) => (
            <h2 className="flex flex-wrap items-center gap-x-2 border-b border-line px-5 py-3 text-[14px] font-semibold">
              {g.label}{extra}
              <span className="ml-auto flex items-center gap-2 text-xs font-normal text-faint">
                {part?.data && <span title={`GET ${g.href}`}>read {fmtDate(part.data.generatedAt)}{cacheNote(part.data)}</span>}
                <button type="button" className="rounded p-1 text-muted enabled:hover:bg-raised enabled:hover:text-ink disabled:opacity-40" disabled={loading}
                  aria-label={`Read ${g.label} again`} title={`Read ${g.label} again`} onClick={() => void refreshPart(zoneId, g.key)}>
                  <RefreshCw className={cx('size-3.5', part?.state === 'loading' && 'animate-spin')} />
                </button>
              </span>
            </h2>
          );
          if (!part || part.state === 'loading' && !part.data) {
            return find ? null : <Card key={g.key} className="mb-4">{head()}<Loading label={`Reading ${g.label} from Cloudflare`} className="px-5 py-4"><SkeletonText lines={3} /></Loading></Card>;
          }
          if (part.state === 'error' && !part.data) {
            return <Card key={g.key} className="mb-4">{head()}<div className="px-5 py-3"><Alert tone="bad" title="Could not read this section">{part.error}</Alert></div></Card>;
          }
          const data = part.data!;
          const mine = readable.filter((s) => s.group === g.key);
          const qq = find.trim().toLowerCase();
          const pages = data.rules.filter((p) => !qq || p.label.toLowerCase().includes(qq) || p.rules.some((r) => JSON.stringify(r).toLowerCase().includes(qq)));
          const sslCerts = g.key === 'ssl' ? certificatesOf(data.sections) : null;
          if (!mine.length && !pages.length && !sslCerts) return null;
          const ruleCount = pages.reduce((n, p) => n + p.rules.length, 0);
          return (
            <Card key={g.key} className="mb-4">
              {head(pages.length > 0 && <span className="text-xs font-normal text-muted">{ruleCount} rule{ruleCount === 1 ? '' : 's'}</span>)}
              {part.state === 'error' && <div className="px-5 pt-3"><Alert tone="bad" title="Could not read this section again">{part.error}</Alert></div>}
              {sslCerts && <Certificates certs={sslCerts} find={find} />}
              <RulePages pages={pages} names={names} find={find} zone={zoneName} />
              {mine.map((s) => <SectionView key={s.key} s={s} open={!!find || s.key === 'zone' || s.key === 'dns_records'} />)}
            </Card>
          );
        })}
        {!readable.length && find && !pending && <Card><p className="px-5 py-4 text-[13px] text-muted">Nothing matches “{find}”.</p></Card>}

        {(empty.length > 0 || missing.length > 0) && (
          <Card className="mb-4">
            <details>
              <summary className="cursor-pointer px-5 py-3 text-[13px] font-medium">
                Empty or not readable: {compactNum(empty.length)} empty, {compactNum(missing.length)} not readable with this token or plan
              </summary>
              <ul className="border-t border-line px-5 py-2 text-[12.5px]">
                {[...missing, ...empty].map((s) => (
                  <li key={s.key} className="flex flex-wrap gap-x-2 border-t border-line/40 py-1.5 first:border-0">
                    <span className="text-ink-2">{s.label}</span>
                    <span className="font-mono text-[11px] text-faint">{s.path}</span>
                    <span className={cx('ml-auto text-xs', s.status === 'empty' ? 'text-muted' : s.status === 'error' ? 'text-bad' : 'text-warn')}>
                      {s.status === 'empty' ? 'nothing configured' : s.message}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </Card>
        )}
        <p className="text-xs text-faint">Secret-looking values (keys, passwords, tokens, credentials in URLs) are masked. Lists are read in full up to 50,000 items. Only current Cloudflare APIs are read — nothing the official API reference marks deprecated (zone settings are read one by one, legacy firewall APIs are skipped). Rules are read per dashboard rule page from its phase entrypoint. Each section is its own endpoint (<span className="font-mono">/api/zone-explorer/{'{zone}'}/sections/{'{section}'}</span>), cached for 10 minutes; ↻ reads one section again.</p>
      </>
    )}
    </>
  );
}
