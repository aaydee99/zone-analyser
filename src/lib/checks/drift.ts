import 'server-only';
import crypto from 'node:crypto';
import { cfGet, cfList, cfOne, inParallel, ok, mask } from '../cf-read';
import { db, must } from '../supabase';
import { SETTING_IDS } from '../zone-catalog';
import type { NewFinding } from '../monitor-store';
import type { Row, Severity } from '../monitor-types';
import { Problems, notAvailable, report, type CheckRunner } from './common';

// Drift: what changed in each zone since its accepted baseline. Each run takes a small snapshot of
// a zone — the settings that matter most for security and caching, the version of every ruleset,
// the DNS records (Cloudflare's BIND export) and DNSSEC — about 25 calls a zone. The first snapshot
// of a zone becomes its baseline; an admin accepts later changes as the new baseline once reviewed.

/** Settings that change how a site is protected or served. */
const WATCHED = ['ssl', 'min_tls_version', 'tls_1_3', 'always_use_https', 'automatic_https_rewrites', 'security_header', 'security_level', 'browser_check',
  'challenge_ttl', 'waf', 'hotlink_protection', 'email_obfuscation', 'opportunistic_encryption', 'ipv6', 'http3', '0rtt', 'cache_level', 'browser_cache_ttl',
  'development_mode', 'always_online', 'true_client_ip_header'].filter((id) => SETTING_IDS.includes(id));
const SECURITY = new Set(['ssl', 'min_tls_version', 'tls_1_3', 'always_use_https', 'security_header', 'security_level', 'browser_check', 'waf', 'development_mode']);

export interface ZoneSnapshot {
  takenAt: string;
  zoneName: string;
  accountId: string;
  accountName: string;
  settings: Record<string, string>;
  rulesets: Record<string, { name: string; phase: string; version: string }>;
  /** DNS records, one per line ("name TTL class type value"), without the SOA. */
  dns: string[];
  dnssec: string;
}
interface Stored { zones: Record<string, ZoneSnapshot>; acceptedAt?: Record<string, { at: string; by: string }> }

const BASELINE = 'drift:baseline';
const LATEST = 'drift:latest';

async function load(id: string): Promise<Stored> {
  const row = must(await db().from('monitor_reports').select('data').eq('check_id', id).maybeSingle(), 'Reading the drift baseline') as { data?: Stored } | null;
  return { zones: row?.data?.zones ?? {}, acceptedAt: row?.data?.acceptedAt ?? {} };
}
async function store(id: string, data: Stored) {
  must(await db().from('monitor_reports').upsert({ check_id: id, data, ran_at: new Date().toISOString(), duration_ms: 0, error: null }), 'Saving the drift baseline');
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(mask(v)));

/** "example.com. 300 IN A 192.0.2.1" lines, sorted, comments and SOA left out. */
function dnsLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim().replace(/\s+/g, ' ')).filter((l) => l && !l.startsWith('$') && !/\bSOA\b/.test(l)).sort();
}

async function snapshot(z: { zoneId: string; zoneName: string; accountId: string; accountName: string; token: string }, signal?: AbortSignal): Promise<ZoneSnapshot> {
  const settings: Record<string, string> = {};
  await inParallel(WATCHED, 6, async (id) => {
    const r = await cfGet<{ value?: unknown }>(z.token, `/zones/${z.zoneId}/settings/${id}`, signal);
    if (ok(r)) settings[id] = show(r.body!.result?.value);
  });
  const rulesets: ZoneSnapshot['rulesets'] = {};
  for (const rs of await cfList<{ id: string; name?: string; phase?: string; kind?: string; version?: string }>(z.token, `/zones/${z.zoneId}/rulesets`, { perPage: 0, signal })) {
    if (rs.kind === 'managed') continue; // Cloudflare's own rulesets change with every release
    rulesets[rs.id] = { name: rs.name ?? '', phase: rs.phase ?? '', version: String(rs.version ?? '') };
  }
  const exp = await cfGet(z.token, `/zones/${z.zoneId}/dns_records/export`, signal);
  const dns = exp.status === 200 && exp.text !== undefined ? dnsLines(exp.text) : [];
  let dnssec = '';
  try { dnssec = (await cfOne<{ status?: string }>(z.token, `/zones/${z.zoneId}/dnssec`, signal)).status ?? ''; } catch (err) { if (!notAvailable(err)) throw err; }
  return { takenAt: new Date().toISOString(), zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName, settings, rulesets, dns, dnssec };
}

interface Change { area: string; item: string; before: string; after: string; severity: Severity }

function diff(base: ZoneSnapshot, now: ZoneSnapshot): Change[] {
  const out: Change[] = [];
  for (const id of new Set([...Object.keys(base.settings), ...Object.keys(now.settings)])) {
    const a = base.settings[id], b = now.settings[id];
    if (a !== undefined && b !== undefined && a !== b) out.push({ area: 'Setting', item: id, before: a, after: b, severity: SECURITY.has(id) ? 'medium' : 'low' });
  }
  for (const id of new Set([...Object.keys(base.rulesets), ...Object.keys(now.rulesets)])) {
    const a = base.rulesets[id], b = now.rulesets[id];
    const name = (b ?? a)!.name || (b ?? a)!.phase;
    if (!a) out.push({ area: 'Rules', item: name, before: '—', after: `added (version ${b!.version})`, severity: 'medium' });
    else if (!b) out.push({ area: 'Rules', item: name, before: `version ${a.version}`, after: 'removed', severity: 'medium' });
    else if (a.version !== b.version) out.push({ area: 'Rules', item: name, before: `version ${a.version}`, after: `version ${b.version}`, severity: 'medium' });
  }
  const was = new Set(base.dns), is = new Set(now.dns);
  for (const l of now.dns) if (!was.has(l)) out.push({ area: 'DNS', item: l, before: '—', after: 'added', severity: 'low' });
  for (const l of base.dns) if (!is.has(l)) out.push({ area: 'DNS', item: l, before: 'present', after: 'removed', severity: 'low' });
  if (base.dnssec !== now.dnssec && base.dnssec && now.dnssec) out.push({ area: 'DNSSEC', item: 'status', before: base.dnssec, after: now.dnssec, severity: 'medium' });
  return out;
}

const keyOf = (zoneId: string, c: Change) => `${zoneId}:${c.area}:${crypto.createHash('sha1').update(`${c.item}\n${c.after}`).digest('hex').slice(0, 16)}`;

export const drift: CheckRunner = async (ctx) => {
  const started = Date.now();
  const p = new Problems();
  const { zones, problems } = await ctx.zones();
  p.list.push(...problems);
  const baseline = await load(BASELINE);
  const latest = await load(LATEST);
  const rows: Row[] = [];
  const zoneRows: Row[] = [];
  const findings: NewFinding[] = [];
  const read = new Set<string>();
  let newBaselines = 0;
  ctx.progress.total = zones.length;
  await inParallel(zones, 2, async (z) => {
    const scope = { zoneId: z.zoneId, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
    try {
      const snap = await snapshot(z, ctx.signal);
      latest.zones[z.zoneId] = snap;
      read.add(z.zoneId);
      const base = baseline.zones[z.zoneId];
      if (!base) { baseline.zones[z.zoneId] = snap; baseline.acceptedAt![z.zoneId] = { at: snap.takenAt, by: 'first check' }; newBaselines++; }
      const changes = base ? diff(base, snap) : [];
      for (const c of changes) {
        rows.push({ zone: z.zoneName, area: c.area, item: c.item, before: c.before, after: c.after, severity: c.severity });
        findings.push({ key: keyOf(z.zoneId, c), severity: c.severity, title: `${c.area} changed on ${z.zoneName}: ${c.item.length > 80 ? `${c.item.slice(0, 80)}…` : c.item}`, detail: `${c.before} → ${c.after}`, ...scope });
      }
      if (snap.dnssec === 'error' || snap.dnssec === 'pending') {
        findings.push({ key: `${z.zoneId}:dnssec:${snap.dnssec}`, severity: snap.dnssec === 'error' ? 'high' : 'medium', title: `DNSSEC is ${snap.dnssec} on ${z.zoneName}`, detail: snap.dnssec === 'pending' ? 'Add the DS record at your registrar to finish turning DNSSEC on.' : 'The DS record at the registrar does not match: resolvers that validate DNSSEC may fail to resolve the zone.', ...scope });
      }
      const accepted = baseline.acceptedAt?.[z.zoneId];
      zoneRows.push({ zoneId: z.zoneId, zone: z.zoneName, account: z.accountName, changes: changes.length, baseline: accepted?.at ?? null, acceptedBy: accepted?.by ?? '', dnssec: snap.dnssec || '—', records: snap.dns.length, _tone: changes.length ? 'warn' : 'ok' });
    } catch (err) {
      p.add(z.zoneName, err);
    }
    ctx.progress.done++;
  });
  await store(LATEST, latest);
  if (newBaselines) await store(BASELINE, baseline);
  const changed = zoneRows.filter((r) => Number(r.changes) > 0).length;
  return {
    report: report('drift', started, [
      { label: 'Zones watched', value: zoneRows.length },
      { label: 'Zones changed', value: changed, tone: changed ? 'warn' : 'ok' },
      { label: 'Changes', value: rows.length, tone: rows.length ? 'warn' : 'ok' },
      { label: 'New baselines', value: newBaselines },
    ], [
      { key: 'changes', title: 'Changes since the baseline', description: 'Accept them as the new baseline once they are reviewed, or restore the zone from a backup to undo them.',
        columns: [{ key: 'severity', label: 'Severity', kind: 'severity' }, { key: 'zone', label: 'Zone' }, { key: 'area', label: 'Area' }, { key: 'item', label: 'What', kind: 'mono' }, { key: 'before', label: 'Was', kind: 'mono' }, { key: 'after', label: 'Now', kind: 'mono' }],
        rows, empty: 'Nothing changed since the baseline.' },
      { key: 'zones', title: 'Zones', columns: [{ key: 'zone', label: 'Zone' }, { key: 'account', label: 'Account' }, { key: 'changes', label: 'Changes', kind: 'number' }, { key: 'dnssec', label: 'DNSSEC', kind: 'status' }, { key: 'records', label: 'DNS records', kind: 'number' }, { key: 'baseline', label: 'Baseline from', kind: 'date' }, { key: 'acceptedBy', label: 'Accepted by' }],
        rows: zoneRows, empty: 'No zones could be read.' },
    ], p.list, p.partial),
    findings, read,
  };
};

/** Makes the newest snapshot the baseline (one zone, or every zone with one). Returns the zones accepted. */
export async function acceptBaseline(by: string, zoneId?: string): Promise<{ id: string; name: string }[]> {
  const latest = await load(LATEST);
  const baseline = await load(BASELINE);
  const ids = zoneId ? [zoneId].filter((id) => latest.zones[id]) : Object.keys(latest.zones);
  for (const id of ids) {
    baseline.zones[id] = latest.zones[id];
    baseline.acceptedAt![id] = { at: new Date().toISOString(), by };
  }
  if (ids.length) await store(BASELINE, baseline);
  return ids.map((id) => ({ id, name: latest.zones[id].zoneName }));
}
