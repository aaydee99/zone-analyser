'use client';

import { isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Download, FileJson, Globe, RefreshCw, Search } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import type { ZoneGroupReport, ZoneListItem, ZoneRulePhase, ZoneSection, ZoneSummary } from '@/lib/zone-catalog';
import { actionDetail, certificatesOf, daysLeft, isExpired, isObj, ruleScope, rulesByHost, text, type CertRow, type RuleScope, type ScopedRule } from '@/lib/zone-format';
import { Alert, Badge, Button, Card, EmptyState, Loading, PageHeader, Skeleton, SkeletonStats, SkeletonText, Stat, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { zoneList } from '@/lib/zone-list-client';

const ROWS = 300;
/** Columns worth showing first for a list of objects. */
const PREFERRED = ['name', 'description', 'hostname', 'type', 'pattern', 'expression', 'action', 'mode', 'status', 'enabled', 'paused', 'value', 'content', 'priority', 'id'];

function Cell({ v }: { v: unknown }) {
  if (isValidElement(v)) return v;
  if (typeof v === 'boolean') return <Badge tone={v ? 'ok' : 'neutral'}>{v ? 'on' : 'off'}</Badge>;
  const s = text(v);
  return <span className={cx('break-all', !s && 'text-faint')} title={s.length > 160 ? s : undefined}>{s.length > 160 ? `${s.slice(0, 160)}…` : s || '—'}</span>;
}

function Table({ head, rows }: { head: string[]; rows: unknown[][] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, ROWS);
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[520px] text-left text-[12px]">
        <thead className="bg-raised/50 text-muted"><tr>{head.map((h) => <th key={h} className="px-3 py-1.5 font-medium whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody className="font-mono">
          {shown.map((r, i) => <tr key={i} className="border-t border-line/50 align-top">{r.map((c, j) => <td key={j} className="px-3 py-1.5"><Cell v={c} /></td>)}</tr>)}
        </tbody>
      </table>
      {rows.length > ROWS && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-line/50 px-3 py-1.5 text-left text-xs text-muted hover:text-ink">
          {all ? 'Show fewer' : `Show all ${rows.length.toLocaleString()} rows`}
        </button>
      )}
    </div>
  );
}

/** A readable view of one section: settings and DNS get their own tables; other lists and objects a generic one. */
function SectionBody({ s }: { s: ZoneSection }) {
  const d = s.data;
  if (s.key.startsWith('settings:') && Array.isArray(d)) {
    return <Table head={['Setting', 'Value', 'Editable', 'Modified']} rows={(d as Record<string, unknown>[]).map((x) => [x.id, x.value, x.editable, x.modified_on ? fmtDate(String(x.modified_on)) : ''])} />;
  }
  if (s.key === 'dns_records' && Array.isArray(d)) {
    return <Table head={['Type', 'Name', 'Content', 'Proxied', 'TTL', 'Priority', 'Comment']} rows={(d as Record<string, unknown>[]).map((x) => [x.type, x.name, x.content, x.proxied, x.ttl === 1 ? 'auto' : x.ttl, x.priority, x.comment])} />;
  }
  if (Array.isArray(d)) {
    const objs = d.filter(isObj);
    if (objs.length !== d.length) return <Table head={['Value']} rows={d.map((x) => [x])} />;
    const keys = [...new Set(objs.flatMap((o) => Object.keys(o)))];
    const cols = [...PREFERRED.filter((k) => keys.includes(k)), ...keys.filter((k) => !PREFERRED.includes(k))].slice(0, 7);
    return <Table head={cols} rows={objs.map((o) => cols.map((k) => o[k]))} />;
  }
  if (isObj(d)) return <Table head={['Field', 'Value']} rows={Object.entries(d).map(([k, v]) => [k, v])} />;
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
          {s.truncated && <Badge tone="warn">first {s.count?.toLocaleString()}</Badge>}
          {s.count !== undefined && <Badge>{s.count.toLocaleString()}</Badge>}
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
                {p.status === 'ok' ? <Badge tone="signal">{p.rules.length} rule{p.rules.length === 1 ? '' : 's'}</Badge>
                  : p.status === 'empty' ? <Badge>none</Badge> : <Badge tone="warn">not readable</Badge>}
              </span>
            </summary>
            <div className="px-5 pb-4">
              {p.status === 'ok' ? (
                <>
                  <Table head={['#', 'Name', 'Applies to', 'Match (expression)', 'Action', 'What it does', 'Enabled']}
                    rows={rules.map((r) => [p.rules.indexOf(r) + 1, r.description || r.ref || r.id, <Scope key="s" s={ruleScope(r.expression)} zone={zone} />, r.expression, r.action, actionDetail(r, names), r.enabled !== false])} />
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
        <span className="ml-auto flex flex-wrap items-center gap-2">{badges}<Badge tone="signal">{rules.length} rule{rules.length === 1 ? '' : 's'}</Badge></span>
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
        <span className="rounded-md border border-line px-2 py-1"><span className="text-muted">Whole zone</span> <b className="tabular-nums">{all.zoneWide.length}</b></span>
        {all.apex.length > 0 && <span className="rounded-md border border-line px-2 py-1"><span className="text-muted">{zone} only</span> <b className="tabular-nums">{all.apex.length}</b></span>}
        {all.hosts.map((h) => <span key={h.host} className="rounded-md border border-signal/40 bg-signal/5 px-2 py-1 font-mono"><span className="text-ink-2">{h.host}</span> <b className="tabular-nums">{h.rules.length}</b></span>)}
        {all.patterns.map((p) => <span key={p.pattern} className="rounded-md border border-warn/40 px-2 py-1 font-mono"><span className="text-ink-2">host {p.pattern}</span> <b className="tabular-nums">{p.rules.length}</b></span>)}
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

type Part = { state: 'loading' | 'ok' | 'error'; data?: ZoneGroupReport; error?: string };

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

/** Runs `fn` over `items`, `n` at a time. */
async function inTurn<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const cacheNote = (p: { cachedIn?: string }) => (p.cachedIn ? ` · from the cache${p.cachedIn === 'redis' ? ' (Redis)' : ''}` : '');

export default function ZoneExplorerPage() {
  const toast = useToast();
  const [zones, setZones] = useState<ZoneListItem[] | null>(null);
  const [problems, setProblems] = useState<{ credential: string; error: string }[]>([]);
  const [listing, setListing] = useState(false);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState('');
  const [summary, setSummary] = useState<ZoneSummary | null>(null);
  const [parts, setParts] = useState<Record<string, Part>>({});
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const [error, setError] = useState('');
  const [find, setFind] = useState('');
  const [saving, setSaving] = useState('');

  const list = useCallback(async (fresh = false) => {
    setListing(true);
    try {
      const r = await zoneList(fresh);
      setZones(r.zones);
      setProblems(r.problems);
    } catch (e) { setZones([]); toast((e as Error).message, 'bad'); } finally { setListing(false); }
  }, [toast]);
  useEffect(() => { list(); }, [list]);

  const readPart = useCallback(async (href: string, key: string, fresh: boolean) => {
    setParts((cur) => ({ ...cur, [key]: { ...cur[key], state: 'loading' } }));
    try {
      const data = await api<ZoneGroupReport>(`${href}${fresh ? '?fresh=1' : ''}`);
      setParts((cur) => ({ ...cur, [key]: { state: 'ok', data } }));
    } catch (e) {
      setParts((cur) => ({ ...cur, [key]: { state: 'error', error: (e as Error).message } }));
    }
  }, []);

  /** Opens a zone: its summary, then each section from its own endpoint (four at a time). */
  const open = useCallback(async (id: string, fresh = false) => {
    if (loadingRef.current) return; // one zone at a time: the list is locked until it has loaded
    loadingRef.current = true;
    setSelected(id);
    setLoading(true);
    setError('');
    if (!fresh) { setSummary(null); setParts({}); }
    try {
      const s = await api<ZoneSummary>(`/api/zone-explorer/${encodeURIComponent(id)}`);
      setSummary(s);
      if (!fresh) setParts(Object.fromEntries(s.sections.map((x) => [x.key, { state: 'loading' } as Part])));
      await inTurn(s.sections, 4, (x) => readPart(x.href, x.key, fresh));
    } catch (e) { setError((e as Error).message); } finally { loadingRef.current = false; setLoading(false); }
  }, [readPart]);

  /** Reads one section again (its own endpoint, live). */
  const refreshPart = useCallback(async (key: string) => {
    const s = summary?.sections.find((x) => x.key === key);
    if (!s || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try { await readPart(s.href, key, true); } finally { loadingRef.current = false; setLoading(false); }
  }, [summary, readPart]);

  const shownZones = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (zones ?? []).filter((z) => !s || [z.name, z.accountName, z.id, z.plan, z.status].some((x) => x.toLowerCase().includes(s)));
  }, [zones, q]);
  const byAccount = useMemo(() => {
    const m = new Map<string, { id: string; name: string; zones: ZoneListItem[] }>();
    for (const z of shownZones) {
      const id = z.accountId || z.accountName || 'unknown';
      const g = m.get(id) ?? { id, name: z.accountName || z.accountId || 'Unknown account', zones: [] };
      g.zones.push(z);
      m.set(id, g);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [shownZones]);

  // Accounts as accordions: open when there is only one, for the open zone's account, and while
  // searching. What you open or close is remembered in this browser.
  const [openAccounts, setOpenAccounts] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { setOpenAccounts(JSON.parse(localStorage.getItem('zx.openAccounts') ?? '{}') as Record<string, boolean>); } catch { /* storage blocked */ }
  }, []);
  const setAccountsOpen = (next: Record<string, boolean>) => {
    setOpenAccounts(next);
    try { localStorage.setItem('zx.openAccounts', JSON.stringify(next)); } catch { /* storage blocked */ }
  };
  const isOpen = (g: { id: string; zones: ZoneListItem[] }) =>
    !!q.trim() || (openAccounts[g.id] ?? (byAccount.length === 1 || g.zones.some((z) => z.id === selected)));
  const allOpen = byAccount.every(isOpen);

  const loaded = useMemo(() => (summary?.sections ?? []).map((x) => parts[x.key]?.data).filter((x): x is ZoneGroupReport => !!x), [summary, parts]);
  const allSections = useMemo(() => loaded.flatMap((p) => p.sections), [loaded]);
  const allRules = useMemo(() => loaded.flatMap((p) => p.rules), [loaded]);
  const names = useMemo(() => Object.assign({}, ...loaded.map((p) => p.rulesetNames)) as Record<string, string>, [loaded]);
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
    <div className="rise">
      <PageHeader eyebrow="Cloudflare" title="Zone explorer"
        description="Everything the stored Cloudflare tokens can read about any zone: settings, DNS, SSL/TLS, security, rules, caching and more. Read-only — only GET requests are sent."
        actions={<Button icon={<RefreshCw className={cx('size-4', listing && 'animate-spin')} />} onClick={() => list(true)} disabled={listing}>Refresh zones</Button>} />

      {problems.map((p) => <div key={p.credential} className="mb-4"><Alert tone="warn" title={p.credential}>{p.error}</Alert></div>)}

      {zones && !zones.length ? (
        <Card><EmptyState icon={<Globe className="size-5" />} title="No zones" description="No stored Cloudflare token can list zones. A super admin adds tokens (with Zone: Read) under Credentials." /></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <Card className="self-start lg:sticky lg:top-4">
            <label className="relative block border-b border-line p-3">
              <span className="sr-only">Find a zone</span>
              <Search className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-1/2 text-faint" aria-hidden />
              <input className="input !pl-9" placeholder={zones ? `Find among ${zones.length} zones…` : 'Loading zones…'} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <div className="max-h-[60vh] overflow-y-auto lg:max-h-[calc(100vh-12rem)]">
              {byAccount.length > 1 && !q.trim() && (
                <div className="flex items-center justify-between border-b border-line/60 px-4 py-2 text-[11px] text-muted">
                  <span>{byAccount.length} accounts</span>
                  <button type="button" className="hover:text-ink" onClick={() => setAccountsOpen(Object.fromEntries(byAccount.map((g) => [g.id, !allOpen])))}>
                    {allOpen ? 'Collapse all' : 'Expand all'}
                  </button>
                </div>
              )}
              {byAccount.map((g) => {
                const expanded = isOpen(g);
                const inactive = g.zones.filter((z) => z.status !== 'active').length;
                return (
                  <section key={g.id} className="border-b border-line/60 last:border-0">
                    <button type="button" aria-expanded={expanded} aria-controls={`zx-acct-${g.id}`}
                      onClick={() => setAccountsOpen({ ...openAccounts, [g.id]: !expanded })}
                      className="sticky top-0 z-10 flex w-full items-center gap-2 bg-surface/95 px-3 py-2.5 text-left backdrop-blur hover:bg-raised/60">
                      <ChevronRight className={cx('size-4 shrink-0 text-faint transition-transform', expanded && 'rotate-90')} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">{g.name}</span>
                        {g.name !== g.id && /^[0-9a-f]{32}$/.test(g.id) && <span className="block truncate font-mono text-[10.5px] text-faint">{g.id}</span>}
                      </span>
                      {inactive > 0 && <Badge tone="warn">{inactive} not active</Badge>}
                      <Badge>{g.zones.length}</Badge>
                    </button>
                    {expanded && (
                      <div id={`zx-acct-${g.id}`} className="pb-1">
                        {g.zones.map((z) => (
                          <button key={z.id} type="button" onClick={() => open(z.id)} aria-pressed={selected === z.id} disabled={loading}
                            title={loading ? 'Wait for the open zone to finish loading' : undefined}
                            className={cx('flex w-full items-center gap-2 py-2 pr-4 pl-9 text-left text-[13px] transition-colors enabled:hover:bg-raised/60 disabled:cursor-not-allowed', selected === z.id ? 'bg-raised text-ink' : loading && 'opacity-50')}>
                            <span className="min-w-0 flex-1 truncate">{z.name}</span>
                            {z.status !== 'active' && <Badge tone="warn">{z.status}</Badge>}
                            <span className="shrink-0 text-[11px] text-faint">{z.plan.replace(/ Website$/, '')}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              {!zones && (
                <Loading label="Loading zones">
                  {[0, 1].map((i) => (
                    <div key={i} className="border-b border-line/60 pb-1 last:border-0">
                      <div className="flex items-center gap-2 px-3 py-2.5"><Skeleton className="size-4 shrink-0" /><Skeleton className="h-3.5 flex-1" /><Skeleton className="h-5 w-7" /></div>
                      {[70, 55, 82, 60].map((w) => (
                        <div key={w} className="flex items-center gap-2 py-2 pr-4 pl-9"><Skeleton className="h-3" style={{ width: `${w}%` }} /><Skeleton className="ml-auto h-3 w-8 shrink-0" /></div>
                      ))}
                    </div>
                  ))}
                </Loading>
              )}
              {zones && !shownZones.length && <p className="px-4 py-3 text-[13px] text-muted">No zone matches.</p>}
            </div>
          </Card>

          <div className="min-w-0">
            {!selected && <Card><EmptyState icon={<Globe className="size-5" />} title="Choose a zone" description="Its full configuration is read from Cloudflare when you open it." /></Card>}
            {error && <div className="mb-4"><Alert tone="bad" title="Could not read the zone">{error}</Alert></div>}
            {selected && !summary && loading && (
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
                      <Button size="sm" icon={<RefreshCw className={cx('size-3.5', loading && 'animate-spin')} />} onClick={() => open(summary.zone.id, true)} disabled={loading}>Read again</Button>
                      <Button size="sm" icon={<FileJson className="size-3.5" />} loading={saving === 'json'} disabled={loading} onClick={() => save('json', `${zoneName}-cloudflare.json`)}>JSON</Button>
                      <Button size="sm" icon={<Download className="size-3.5" />} loading={saving === 'csv'} disabled={loading} title="All configuration: one row per value" onClick={() => save('csv', `${zoneName}-cloudflare.csv`)}>All as CSV</Button>
                      <Button size="sm" icon={<Download className="size-3.5" />} loading={saving === 'dnsCsv'} disabled={!Array.isArray(dns?.data) || !dns.data.length} onClick={() => save('dnsCsv', `${zoneName}-dns.csv`)}>DNS CSV</Button>
                      <Button size="sm" icon={<Download className="size-3.5" />} loading={saving === 'bind'} disabled={dns?.status !== 'ok'} onClick={() => save('bind', `${zoneName}.txt`)}>BIND file</Button>
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
                </Card>

                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                  <Stat label="Sections read" value={allSections.filter((s) => s.status === 'ok').length} sub={`of ${allSections.length} endpoints`} />
                  <Stat label="DNS records" value={dns?.count?.toLocaleString() ?? '—'} sub={dns?.truncated ? 'first ones only' : ' '} />
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
                          aria-label={`Read ${g.label} again`} title={`Read ${g.label} again`} onClick={() => refreshPart(g.key)}>
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
                        Empty or not readable: {empty.length} empty, {missing.length} not readable with this token or plan
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
          </div>
        </div>
      )}
    </div>
  );
}
