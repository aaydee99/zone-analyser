import 'server-only';
import { compactNum } from '../num';
import crypto from 'node:crypto';
import { BudgetError, ReadError, cfGet, cfList, cfOne, cfReason, inParallel, ok, mask, refused } from '../cf-read';
import { db } from '../supabase';
import { must, readState } from '../monitor-store';
import { SETTING_IDS } from '../zone-catalog';
import type { NewFinding } from '../monitor-store';
import type { Row, Severity } from '../monitor-types';
import { notAvailable, readStat, type CheckDef, type UnitTarget } from './common';
import { completeBaseline, diffSnapshots, dnsLines, mergeTrail, ruleSnaps, whoChanged, type AuditTrail, type RulesetSnap, type ZoneSnapshot } from './drift-diff';
import { REPORT_TZ } from '../report-types';

export type { ZoneSnapshot } from './drift-diff';

// Drift: what changed in each zone since its accepted baseline. A zone's snapshot — the settings that
// matter most for security and caching, every ruleset and its rules, the DNS records (Cloudflare's
// BIND export, with proxy status) and DNSSEC — costs about 25 calls (and one per ruleset whose version
// changed), so it is not taken on a timer for every zone:
// each account's audit log is read every hour (one call), and only the zones it shows a change in
// are snapshotted again. Every zone is still read in full once a week, for changes the audit log
// does not show. The first snapshot of a zone becomes its baseline; an admin accepts later changes
// as the new baseline once reviewed (monitor_accept_baseline in 0011_monitor_queue.sql). Each change
// says exactly what changed (drift-diff.ts): the setting field, the rule and its field, the DNS record
// and its value, TTL or proxy status — with what it was and what it is now, and who changed it and
// when: the hourly audit-log read keeps each zone's changes (who, when, what URL) in the account's
// state, and each drift change is matched with the newest entry since the baseline for that setting,
// ruleset, DNS record or DNSSEC.

/** Settings that change how a site is protected or served. */
const WATCHED = ['ssl', 'min_tls_version', 'tls_1_3', 'always_use_https', 'automatic_https_rewrites', 'security_header', 'security_level', 'browser_check',
  'challenge_ttl', 'waf', 'hotlink_protection', 'email_obfuscation', 'opportunistic_encryption', 'ipv6', 'http3', '0rtt', 'cache_level', 'browser_cache_ttl',
  'development_mode', 'always_online', 'true_client_ip_header'].filter((id) => SETTING_IDS.includes(id));
/** Audit-log entries read per account and run (pages of 1,000). */
const AUDIT_PAGES = 10;
/** Each run reads the audit log again from a little before the last one ended: entries can show up late. */
const AUDIT_OVERLAP_MS = 15 * 60_000;
/** The audit log kept per zone in the account's state (whoChanged): how long and how many. */
interface DriftState { since?: string; by?: Record<string, AuditTrail[]> }
const ET = new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
/** "Nov 2, 2026, 10:42 AM EST" (times are shown in US Eastern). */
const eastern = (iso: string) => ET.format(new Date(iso));

interface AuditEntry { zone?: { id?: string }; action?: { time?: string }; when?: string; actor?: { email?: string; type?: string; token_name?: string }; raw?: { method?: string; uri?: string }; resource?: { request?: unknown } }
/** Who: the person's email, the API token's name, or the kind of actor (Cloudflare, a system). */
const actorOf = (e: AuditEntry) => e.actor?.email || (e.actor?.token_name ? `API token “${e.actor.token_name}”` : e.actor?.type || 'unknown');
const targetOf = (e: AuditEntry) => {
  const q = e.resource?.request;
  const one = Array.isArray(q) ? q[0] : q;
  return one && typeof one === 'object' && typeof (one as { name?: unknown }).name === 'string' ? (one as { name: string }).name : '';
};

/** Changes only (no views, reads or failed requests), as in src/lib/cf-audit.ts. */
const CHANGES_ONLY: [string, string][] = [['action_type.not', 'view'], ['raw_method.not', 'GET'], ['raw_method.not', 'HEAD'], ['action_result.not', 'failure']];

/** A snapshot, the parts of it that could not be read, and why. */
interface Taken { snap: ZoneSnapshot; failedSettings: string[]; problems: string[] }

interface SnapshotRow { zone_id: string; kind: 'baseline' | 'latest'; data: ZoneSnapshot; taken_at: string; accepted_at: string | null; accepted_by: string | null }

async function readSnapshot(zoneId: string, kind: 'baseline' | 'latest'): Promise<SnapshotRow | null> {
  return must(await db().from('monitor_snapshots').select('*').eq('zone_id', zoneId).eq('kind', kind).maybeSingle(), 'Reading the drift baseline') as SnapshotRow | null;
}
async function saveSnapshot(row: SnapshotRow) {
  must(await db().from('monitor_snapshots').upsert(row), 'Saving the drift baseline');
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(mask(v)));

/** Rulesets whose rules are read at once (one call each, only when a ruleset's version changed). */
const RULESET_READS = 4;

/**
 * A new snapshot of a zone. What could not be read is left out (a setting) or null (DNS records,
 * DNSSEC) instead of looking empty, so it is not compared — a failed DNS export must not look like
 * every record was deleted.
 */
async function snapshot(z: UnitTarget, older: ZoneSnapshot | null, signal?: AbortSignal): Promise<Taken> {
  const settings: Record<string, string> = {};
  const failedSettings: string[] = [];
  const problems: string[] = [];
  await inParallel(WATCHED, 6, async (id) => {
    const r = await cfGet<{ value?: unknown }>(z.token, `/zones/${z.id}/settings/${id}`, signal);
    if (ok(r)) settings[id] = show(r.body!.result?.value);
    // Not there (404, or not on the plan): nothing to watch. Anything else: not known this time.
    else if (!notAvailable(new ReadError(r.status, cfReason(r)))) failedSettings.push(id);
  });
  if (failedSettings.length) problems.push(`Settings not read (${failedSettings.join(', ')}): not compared this time`);
  const rulesets: Record<string, RulesetSnap> = {};
  for (const rs of await cfList<{ id: string; name?: string; phase?: string; kind?: string; version?: string }>(z.token, `/zones/${z.id}/rulesets`, { perPage: 0, signal })) {
    if (rs.kind === 'managed') continue; // Cloudflare's own rulesets change with every release
    rulesets[rs.id] = { name: rs.name ?? '', phase: rs.phase ?? '', version: String(rs.version ?? '') };
  }
  // The rules of each ruleset, to say which rule changed and how: the same version as the last
  // snapshot is the same rules (kept from it); only a new version is read again.
  const unread: string[] = [];
  await inParallel(Object.keys(rulesets), RULESET_READS, async (id) => {
    const rs = rulesets[id];
    const kept = older?.rulesets?.[id];
    if (kept?.rules && kept.version === rs.version) { rs.rules = kept.rules; return; }
    try { rs.rules = ruleSnaps((await cfOne<{ rules?: unknown }>(z.token, `/zones/${z.id}/rulesets/${id}`, signal)).rules, mask); } catch (err) {
      if (err instanceof BudgetError || (err instanceof Error && err.name === 'AbortError')) throw err;
      unread.push(rs.name || rs.phase || id);
    }
  });
  if (unread.length) problems.push(`Rules of ${unread.join(', ')} not read: compared by version only this time`);
  const exp = await cfGet(z.token, `/zones/${z.id}/dns_records/export`, signal);
  const bind = exp.status === 200 && exp.text !== undefined ? dnsLines(exp.text) : null;
  const dns = bind?.lines ?? null;
  if (!dns) problems.push(`DNS records could not be exported (${exp.status === 200 ? 'no BIND file in the answer' : cfReason(exp)}): not compared this time`);
  let dnssec: string | null = '';
  try { dnssec = (await cfOne<{ status?: string }>(z.token, `/zones/${z.id}/dnssec`, signal)).status ?? ''; } catch (err) {
    if (err instanceof BudgetError || (err instanceof Error && err.name === 'AbortError')) throw err;
    if (!notAvailable(err)) { dnssec = null; problems.push(`DNSSEC could not be read (${err instanceof Error ? err.message : String(err)}): not compared this time`); }
  }
  return { snap: { takenAt: new Date().toISOString(), zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName, settings, rulesets, dns, dnsProxied: bind?.proxied ?? null, dnssec }, failedSettings, problems };
}

/** The snapshot to keep as the newest: what could not be read now stays as it was in `older`. */
function keepUnread(t: Taken, older: ZoneSnapshot | null): ZoneSnapshot {
  const s = t.snap;
  if (!older) return s;
  const settings = { ...s.settings };
  for (const id of t.failedSettings) if (older.settings?.[id] !== undefined) settings[id] = older.settings[id];
  const dnsRead = s.dns != null;
  return { ...s, settings, dns: dnsRead ? s.dns : older.dns ?? null, dnsProxied: dnsRead ? s.dnsProxied : older.dnsProxied ?? null, dnssec: s.dnssec ?? older.dnssec ?? null };
}

const keyOf = (zoneId: string, c: { area: string; item: string; after: string }) => `${zoneId}:${c.area}:${crypto.createHash('sha1').update(`${c.item}\n${c.after}`).digest('hex').slice(0, 16)}`;
const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export const drift: CheckDef = {
  id: 'drift', main: 'account', every: { zone: 168 }, stateful: ['account'],
  units: {
    // The account's audit log since the last look: which zones changed.
    account: async (a, ctx) => {
      const before = new Date();
      const st = (ctx.state as DriftState | null) ?? {};
      const since = st.since;
      // First look: nothing to compare with yet (the weekly read of every zone takes the baselines).
      if (!since || !Number.isFinite(Date.parse(since))) return { rows: {}, findings: [], complete: true, state: { since: before.toISOString(), by: {} } };
      const zones = new Set<string>();
      const found: Record<string, AuditTrail[]> = {};
      /** The state to keep: where to read from next, and each zone's recent changes (who and what). */
      const keep = (next: string): DriftState => {
        const by: Record<string, AuditTrail[]> = {};
        for (const id of new Set([...Object.keys(st.by ?? {}), ...Object.keys(found)])) {
          const t = mergeTrail(st.by?.[id], found[id] ?? []);
          if (t.length) by[id] = t;
        }
        return { since: next, by };
      };
      let cursor = '';
      let done = false;
      /** The newest entry read. The log is read oldest first, so a run that stops at AUDIT_PAGES leaves the rest for the next. */
      let last = '';
      for (let page = 0; page < AUDIT_PAGES; page++) {
        const q = new URLSearchParams([['since', since], ['before', before.toISOString()], ['limit', '1000'], ['direction', 'asc'], ...CHANGES_ONLY]);
        if (cursor) q.set('cursor', cursor);
        const r = await cfGet<AuditEntry[]>(a.token, `/accounts/${a.accountId}/logs/audit?${q}`, ctx.signal);
        if (!ok(r)) {
          const why = refused(r) ? `The audit log cannot be read (${cfReason(r)}): add Account Settings Read — until then, changes show up at the weekly read of every zone` : `The audit log could not be read (${cfReason(r)})`;
          return { rows: {}, findings: [], complete: false, problems: [why], state: keep(since), ...(zones.size ? { wake: { kind: 'zone' as const, ids: [...zones] } } : {}) };
        }
        for (const e of Array.isArray(r.body!.result) ? r.body!.result : []) {
          const t = e?.action?.time ?? e?.when;
          if (e?.zone?.id) {
            zones.add(e.zone.id);
            if (typeof t === 'string' && Number.isFinite(Date.parse(t))) (found[e.zone.id] ??= []).push({ time: t, who: actorOf(e), method: e.raw?.method ?? '', uri: e.raw?.uri ?? '', target: targetOf(e) });
          }
          if (typeof t === 'string' && Number.isFinite(Date.parse(t)) && (!last || Date.parse(t) > Date.parse(last))) last = t;
        }
        cursor = r.body!.result_info?.cursor ?? '';
        if (!cursor) { done = true; break; }
      }
      if (!done) {
        // More changes than one run reads: the next run, in a few minutes, starts at the newest one read.
        const from = last && Date.parse(last) > Date.parse(since) ? last : since;
        return {
          rows: {}, findings: [], complete: false, counts: { auditChanged: zones.size }, dueInHours: 0.1,
          problems: [`More than ${compactNum((AUDIT_PAGES * 1000))} changes in the audit log since ${since}: read up to ${from}, the rest in a few minutes`],
          state: keep(from),
          ...(zones.size ? { wake: { kind: 'zone' as const, ids: [...zones] } } : {}),
        };
      }
      return {
        rows: {}, findings: [], complete: true, counts: { auditChanged: zones.size },
        state: keep(new Date(before.getTime() - AUDIT_OVERLAP_MS).toISOString()),
        ...(zones.size ? { wake: { kind: 'zone' as const, ids: [...zones] } } : {}),
      };
    },
    // One zone: a new snapshot, compared with its baseline.
    zone: async (z, ctx) => {
      const scope = { zoneId: z.id, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
      let base = await readSnapshot(z.id, 'baseline');
      const first = !base;
      const prev = first ? null : await readSnapshot(z.id, 'latest');
      const taken = await snapshot(z, prev?.data ?? base?.data ?? null, ctx.signal);
      const snap = taken.snap;
      // What could not be read now is kept as it was in the newest snapshot, not saved as missing.
      const latest = keepUnread(taken, prev?.data ?? base?.data ?? null);
      await saveSnapshot({ zone_id: z.id, kind: 'latest', data: latest, taken_at: snap.takenAt, accepted_at: null, accepted_by: null });
      if (!base) {
        base = { zone_id: z.id, kind: 'baseline', data: latest, taken_at: snap.takenAt, accepted_at: snap.takenAt, accepted_by: 'first check' };
        await saveSnapshot(base);
      } else {
        // A part the baseline could not keep when it was taken comes from the first read that has it.
        const filled = completeBaseline(base.data, snap);
        if (filled) { base = { ...base, data: filled }; await saveSnapshot(base); }
      }
      const changes = first ? [] : diffSnapshots(base.data, snap);
      // Who changed each one: the account's audit log as the hourly read kept it for this zone.
      const trail = changes.length ? ((await readState({ check: 'drift', kind: 'account', id: z.accountId }) as DriftState | null)?.by?.[z.id] ?? []) : [];
      const sinceBase = base.accepted_at ?? base.taken_at;
      const who = changes.map((c) => whoChanged(c, trail, sinceBase));
      const rows: Row[] = changes.map((c, i) => ({ zone: z.zoneName, area: c.area, item: c.item, before: c.before, after: c.after, changedBy: who[i]?.who ?? 'Not in the audit log', changedAt: who[i]?.time ?? null, severity: c.severity, _sort: SEV_ORDER[c.severity] }));
      const findings: NewFinding[] = changes.map((c, i) => ({ key: keyOf(z.id, c), severity: c.severity, title: `${c.area} changed on ${z.zoneName}: ${c.item.length > 80 ? `${c.item.slice(0, 80)}…` : c.item}`, detail: `${c.before} → ${c.after}${who[i] ? ` · changed by ${who[i]!.who} on ${eastern(who[i]!.time)}` : ''}`, ...scope }));
      if (snap.dnssec === 'error' || snap.dnssec === 'pending') {
        findings.push({ key: `${z.id}:dnssec:${snap.dnssec}`, severity: snap.dnssec === 'error' ? 'high' : 'medium', title: `DNSSEC is ${snap.dnssec} on ${z.zoneName}`, detail: snap.dnssec === 'pending' ? 'Add the DS record at your registrar to finish turning DNSSEC on.' : 'The DS record at the registrar does not match: resolvers that validate DNSSEC may fail to resolve the zone.', ...scope });
      }
      const zoneRow: Row = { zoneId: z.id, zone: z.zoneName, account: z.accountName, changes: changes.length, baseline: base.accepted_at ?? base.taken_at, acceptedBy: base.accepted_by ?? '', dnssec: latest.dnssec || '—', records: latest.dns?.length ?? null, _tone: changes.length ? 'warn' : 'ok', _sort: changes.length ? 0 : 1 };
      return { rows: { changes: rows, zones: [zoneRow] }, findings, complete: !taken.problems.length, problems: taken.problems, counts: { zones: 1, changed: changes.length ? 1 : 0, changes: changes.length, newBaseline: first ? 1 : 0 } };
    },
  },
  sections: [
    { key: 'changes', title: 'Changes since the baseline', description: 'Who made each change and when come from the account’s Cloudflare audit log (the newest entry since the baseline for that setting, ruleset or DNS record; kept for 35 days). Accept them as the new baseline once they are reviewed, or restore the zone from a backup to undo them.',
      columns: [{ key: 'severity', label: 'Severity', kind: 'severity' }, { key: 'zone', label: 'Zone' }, { key: 'area', label: 'Area' }, { key: 'item', label: 'What', kind: 'mono' }, { key: 'before', label: 'Was', kind: 'mono' }, { key: 'after', label: 'Now', kind: 'mono' }, { key: 'changedBy', label: 'Changed by' }, { key: 'changedAt', label: 'When', kind: 'date' }],
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
