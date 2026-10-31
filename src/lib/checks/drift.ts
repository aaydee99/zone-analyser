import 'server-only';
import crypto from 'node:crypto';
import { cfGet, cfList, cfOne, cfReason, inParallel, ok, mask, refused } from '../cf-read';
import { db } from '../supabase';
import { must } from '../monitor-store';
import { SETTING_IDS } from '../zone-catalog';
import type { NewFinding } from '../monitor-store';
import type { Row, Severity } from '../monitor-types';
import { notAvailable, readStat, type CheckDef, type UnitTarget } from './common';

// Drift: what changed in each zone since its accepted baseline. A zone's snapshot — the settings that
// matter most for security and caching, the version of every ruleset, the DNS records (Cloudflare's
// BIND export) and DNSSEC — costs about 25 calls, so it is not taken on a timer for every zone:
// each account's audit log is read every hour (one call), and only the zones it shows a change in
// are snapshotted again. Every zone is still read in full once a week, for changes the audit log
// does not show. The first snapshot of a zone becomes its baseline; an admin accepts later changes
// as the new baseline once reviewed (monitor_accept_baseline in 0011_monitor_queue.sql).

/** Settings that change how a site is protected or served. */
const WATCHED = ['ssl', 'min_tls_version', 'tls_1_3', 'always_use_https', 'automatic_https_rewrites', 'security_header', 'security_level', 'browser_check',
  'challenge_ttl', 'waf', 'hotlink_protection', 'email_obfuscation', 'opportunistic_encryption', 'ipv6', 'http3', '0rtt', 'cache_level', 'browser_cache_ttl',
  'development_mode', 'always_online', 'true_client_ip_header'].filter((id) => SETTING_IDS.includes(id));
const SECURITY = new Set(['ssl', 'min_tls_version', 'tls_1_3', 'always_use_https', 'security_header', 'security_level', 'browser_check', 'waf', 'development_mode']);
/** Audit-log entries read per account and run (pages of 1,000). */
const AUDIT_PAGES = 10;
/** Each run reads the audit log again from a little before the last one ended: entries can show up late. */
const AUDIT_OVERLAP_MS = 15 * 60_000;
/** Changes only (no views, reads or failed requests), as in src/lib/cf-audit.ts. */
const CHANGES_ONLY: [string, string][] = [['action_type.not', 'view'], ['raw_method.not', 'GET'], ['raw_method.not', 'HEAD'], ['action_result.not', 'failure']];

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

interface SnapshotRow { zone_id: string; kind: 'baseline' | 'latest'; data: ZoneSnapshot; taken_at: string; accepted_at: string | null; accepted_by: string | null }

async function readSnapshot(zoneId: string, kind: 'baseline' | 'latest'): Promise<SnapshotRow | null> {
  return must(await db().from('monitor_snapshots').select('*').eq('zone_id', zoneId).eq('kind', kind).maybeSingle(), 'Reading the drift baseline') as SnapshotRow | null;
}
async function saveSnapshot(row: SnapshotRow) {
  must(await db().from('monitor_snapshots').upsert(row), 'Saving the drift baseline');
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(mask(v)));

/** "example.com. 300 IN A 192.0.2.1" lines, sorted, comments and SOA left out. */
function dnsLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim().replace(/\s+/g, ' ')).filter((l) => l && !l.startsWith('$') && !/\bSOA\b/.test(l)).sort();
}

async function snapshot(z: UnitTarget, signal?: AbortSignal): Promise<ZoneSnapshot> {
  const settings: Record<string, string> = {};
  await inParallel(WATCHED, 6, async (id) => {
    const r = await cfGet<{ value?: unknown }>(z.token, `/zones/${z.id}/settings/${id}`, signal);
    if (ok(r)) settings[id] = show(r.body!.result?.value);
  });
  const rulesets: ZoneSnapshot['rulesets'] = {};
  for (const rs of await cfList<{ id: string; name?: string; phase?: string; kind?: string; version?: string }>(z.token, `/zones/${z.id}/rulesets`, { perPage: 0, signal })) {
    if (rs.kind === 'managed') continue; // Cloudflare's own rulesets change with every release
    rulesets[rs.id] = { name: rs.name ?? '', phase: rs.phase ?? '', version: String(rs.version ?? '') };
  }
  const exp = await cfGet(z.token, `/zones/${z.id}/dns_records/export`, signal);
  const dns = exp.status === 200 && exp.text !== undefined ? dnsLines(exp.text) : [];
  let dnssec = '';
  try { dnssec = (await cfOne<{ status?: string }>(z.token, `/zones/${z.id}/dnssec`, signal)).status ?? ''; } catch (err) { if (!notAvailable(err)) throw err; }
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
const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export const drift: CheckDef = {
  id: 'drift', main: 'account', every: { zone: 168 }, stateful: ['account'],
  units: {
    // The account's audit log since the last look: which zones changed.
    account: async (a, ctx) => {
      const before = new Date();
      const since = (ctx.state as { since?: string } | null)?.since;
      // First look: nothing to compare with yet (the weekly read of every zone takes the baselines).
      if (!since || !Number.isFinite(Date.parse(since))) return { rows: {}, findings: [], complete: true, state: { since: before.toISOString() } };
      const zones = new Set<string>();
      let cursor = '';
      for (let page = 0; page < AUDIT_PAGES; page++) {
        const q = new URLSearchParams([['since', since], ['before', before.toISOString()], ['limit', '1000'], ['direction', 'desc'], ...CHANGES_ONLY]);
        if (cursor) q.set('cursor', cursor);
        const r = await cfGet<{ zone?: { id?: string } }[]>(a.token, `/accounts/${a.accountId}/logs/audit?${q}`, ctx.signal);
        if (!ok(r)) {
          const why = refused(r) ? `The audit log cannot be read (${cfReason(r)}): add Account Settings Read — until then, changes show up at the weekly read of every zone` : `The audit log could not be read (${cfReason(r)})`;
          return { rows: {}, findings: [], complete: false, problems: [why], state: { since }, ...(zones.size ? { wake: { kind: 'zone' as const, ids: [...zones] } } : {}) };
        }
        for (const e of Array.isArray(r.body!.result) ? r.body!.result : []) if (e?.zone?.id) zones.add(e.zone.id);
        cursor = r.body!.result_info?.cursor ?? '';
        if (!cursor) break;
      }
      return {
        rows: {}, findings: [], complete: true, counts: { auditChanged: zones.size },
        state: { since: new Date(before.getTime() - AUDIT_OVERLAP_MS).toISOString() },
        ...(zones.size ? { wake: { kind: 'zone' as const, ids: [...zones] } } : {}),
      };
    },
    // One zone: a new snapshot, compared with its baseline.
    zone: async (z, ctx) => {
      const scope = { zoneId: z.id, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
      const snap = await snapshot(z, ctx.signal);
      let base = await readSnapshot(z.id, 'baseline');
      const first = !base;
      await saveSnapshot({ zone_id: z.id, kind: 'latest', data: snap, taken_at: snap.takenAt, accepted_at: null, accepted_by: null });
      if (!base) {
        base = { zone_id: z.id, kind: 'baseline', data: snap, taken_at: snap.takenAt, accepted_at: snap.takenAt, accepted_by: 'first check' };
        await saveSnapshot(base);
      }
      const changes = first ? [] : diff(base.data, snap);
      const rows: Row[] = changes.map((c) => ({ zone: z.zoneName, area: c.area, item: c.item, before: c.before, after: c.after, severity: c.severity, _sort: SEV_ORDER[c.severity] }));
      const findings: NewFinding[] = changes.map((c) => ({ key: keyOf(z.id, c), severity: c.severity, title: `${c.area} changed on ${z.zoneName}: ${c.item.length > 80 ? `${c.item.slice(0, 80)}…` : c.item}`, detail: `${c.before} → ${c.after}`, ...scope }));
      if (snap.dnssec === 'error' || snap.dnssec === 'pending') {
        findings.push({ key: `${z.id}:dnssec:${snap.dnssec}`, severity: snap.dnssec === 'error' ? 'high' : 'medium', title: `DNSSEC is ${snap.dnssec} on ${z.zoneName}`, detail: snap.dnssec === 'pending' ? 'Add the DS record at your registrar to finish turning DNSSEC on.' : 'The DS record at the registrar does not match: resolvers that validate DNSSEC may fail to resolve the zone.', ...scope });
      }
      const zoneRow: Row = { zoneId: z.id, zone: z.zoneName, account: z.accountName, changes: changes.length, baseline: base.accepted_at ?? base.taken_at, acceptedBy: base.accepted_by ?? '', dnssec: snap.dnssec || '—', records: snap.dns.length, _tone: changes.length ? 'warn' : 'ok', _sort: changes.length ? 0 : 1 };
      return { rows: { changes: rows, zones: [zoneRow] }, findings, complete: true, counts: { zones: 1, changed: changes.length ? 1 : 0, changes: changes.length, newBaseline: first ? 1 : 0 } };
    },
  },
  sections: [
    { key: 'changes', title: 'Changes since the baseline', description: 'Accept them as the new baseline once they are reviewed, or restore the zone from a backup to undo them.',
      columns: [{ key: 'severity', label: 'Severity', kind: 'severity' }, { key: 'zone', label: 'Zone' }, { key: 'area', label: 'Area' }, { key: 'item', label: 'What', kind: 'mono' }, { key: 'before', label: 'Was', kind: 'mono' }, { key: 'after', label: 'Now', kind: 'mono' }],
      empty: 'Nothing changed since the baseline.' },
    { key: 'zones', title: 'Zones', description: 'Changed zones first. A zone is read again within the hour after its audit log shows a change, and in full once a week.',
      columns: [{ key: 'zone', label: 'Zone' }, { key: 'account', label: 'Account' }, { key: 'changes', label: 'Changes', kind: 'number' }, { key: 'dnssec', label: 'DNSSEC', kind: 'status' }, { key: 'records', label: 'DNS records', kind: 'number' }, { key: 'baseline', label: 'Baseline from', kind: 'date' }, { key: 'acceptedBy', label: 'Accepted by' }],
      empty: 'No zones read yet.' },
  ],
  stats: (t) => [
    { label: 'Zones watched', value: t.counts.zones ?? 0 },
    { label: 'Zones changed', value: t.counts.changed ?? 0, tone: t.counts.changed ? 'warn' : 'ok' },
    { label: 'Changes', value: t.counts.changes ?? 0, tone: t.counts.changes ? 'warn' : 'ok' },
    readStat(t, 'Zones and audit logs read'),
  ],
};

/** Makes the newest snapshot the baseline (one zone, or every zone with one). Returns the zones accepted. */
export async function acceptBaseline(by: string, zoneId?: string): Promise<{ id: string; name: string }[]> {
  const rows = must(await db().rpc('monitor_accept_baseline', { p_zone: zoneId ?? null, p_by: by }), 'Accepting the drift baseline') as { zone_id: string; zone_name: string }[] | null;
  return (rows ?? []).map((r) => ({ id: r.zone_id, name: r.zone_name }));
}
