import type { Severity } from '../monitor-types';

// Drift, the pure part: a zone's snapshot and what exactly changed between two of them — each
// setting field, each rule (added, removed, turned on or off, its action, expression or parameters,
// moved), each DNS record (added, removed, or its TTL, value or proxy status changed) and DNSSEC.
// Shared by the drift check (checks/drift.ts) and tests — no Node imports.

/** One rule of a ruleset, as kept in a snapshot. `params` is everything else about it (masked JSON, keys sorted). */
export interface RuleSnap { id: string; description: string; expression: string; action: string; enabled: boolean; params: string }

export interface RulesetSnap {
  name: string;
  phase: string;
  version: string;
  /** Its rules, in order; missing: not read (snapshots before rule details were kept, or a failed read). */
  rules?: RuleSnap[];
}

export interface ZoneSnapshot {
  takenAt: string;
  zoneName: string;
  accountId: string;
  accountName: string;
  settings: Record<string, string>;
  rulesets: Record<string, RulesetSnap>;
  /** DNS records, one per line ("name TTL class type value"), without the SOA; null: not read (nothing to compare). */
  dns: string[] | null;
  /** The lines of `dns` that are proxied through Cloudflare; missing or null: not known (not compared). */
  dnsProxied?: string[] | null;
  /** DNSSEC status ('' when the zone has none); null: not read. */
  dnssec: string | null;
}

/** What a change is about, to find who made it in the audit log. */
export type ChangeRef = { kind: 'setting'; id: string } | { kind: 'ruleset'; id: string; phase: string } | { kind: 'dns'; name: string } | { kind: 'dnssec' };

export interface Change { area: string; item: string; before: string; after: string; severity: Severity; ref?: ChangeRef }

/** One change in the account's audit log, as drift keeps it to say who changed what. */
export interface AuditTrail { time: string; who: string; method: string; uri: string; target: string }

/** Settings that change how a site is protected: a change to one is medium, the others low. */
export const SECURITY_SETTINGS = new Set(['ssl', 'min_tls_version', 'tls_1_3', 'always_use_https', 'security_header', 'security_level', 'browser_check', 'waf', 'development_mode']);

const clean = (l: string) => l.replace(/;.*$/, '').trim().replace(/\s+/g, ' ');

/** Cloudflare's BIND export as sorted lines (comments and SOA left out), and which of them are proxied (its "cf-proxied:true" tags). */
export function dnsLines(text: string): { lines: string[]; proxied: string[] } {
  const lines: string[] = [];
  const proxied: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = clean(raw);
    if (!l || l.startsWith('$') || /\bSOA\b/.test(l)) continue;
    lines.push(l);
    if (/cf_tags=[^\s;]*cf-proxied:true/.test(raw)) proxied.push(l);
  }
  return { lines: lines.sort(), proxied: [...new Set(proxied)].sort() };
}

/** JSON with its keys sorted, so the same object always reads the same. */
export function stable(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x);
  return JSON.stringify(sort(v)) ?? '';
}

/** Fields of a rule shown on their own; the rest is compared as its parameters. Versions and dates change with any edit of the ruleset. */
const RULE_OWN = new Set(['id', 'description', 'expression', 'action', 'enabled', 'version', 'last_updated', 'ref', 'categories']);

/** A ruleset's rules (Cloudflare's answer) as kept in a snapshot. `hide` masks secrets in the parameters. */
export function ruleSnaps(rules: unknown, hide: (v: unknown) => unknown = (v) => v): RuleSnap[] {
  return (Array.isArray(rules) ? rules : []).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof r.id === 'string').map((r) => {
    const rest = Object.fromEntries(Object.entries(r).filter(([k]) => !RULE_OWN.has(k)));
    return {
      id: r.id as string,
      description: typeof r.description === 'string' ? r.description : typeof r.ref === 'string' ? r.ref : '',
      expression: typeof r.expression === 'string' ? r.expression : '',
      action: typeof r.action === 'string' ? r.action : '',
      enabled: r.enabled !== false,
      params: Object.keys(rest).length ? stable(hide(rest)) : '',
    };
  });
}

const parse = (s: string): unknown => { try { return /^[{[]/.test(s) ? JSON.parse(s) : undefined; } catch { return undefined; } };
const shown = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

/** Every leaf of an object, by its path ("strict_transport_security.max_age"). */
function leaves(v: unknown, path = '', out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
    for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out);
  } else out.set(path, v);
  return out;
}

/** The fields that differ between two values (both JSON objects), or the whole value when they are not objects. */
function fieldChanges(a: string, b: string): { path: string; before: string; after: string }[] {
  const x = parse(a), y = parse(b);
  const objects = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!objects(x) || !objects(y)) return [{ path: '', before: a, after: b }];
  const la = leaves(x), lb = leaves(y);
  const out: { path: string; before: string; after: string }[] = [];
  for (const p of [...new Set([...la.keys(), ...lb.keys()])].sort()) {
    const before = shown(la.get(p)), after = shown(lb.get(p));
    if (before !== after) out.push({ path: p, before, after });
  }
  return out.length ? out : [{ path: '', before: a, after: b }];
}

const ruleLabel = (r: RuleSnap) => r.description || `rule ${r.id.slice(0, 8)}`;
const ruleText = (r: RuleSnap) => `${r.action || 'rule'}${r.enabled ? '' : ' (off)'} when ${r.expression || '—'}`;

function ruleChanges(set: string, a: RuleSnap[], b: RuleSnap[]): Change[] {
  const out: Change[] = [];
  const was = new Map(a.map((r) => [r.id, r])), is = new Map(b.map((r) => [r.id, r]));
  for (const r of b) if (!was.has(r.id)) out.push({ area: 'Rules', item: `${set} › ${ruleLabel(r)}`, before: '—', after: `added: ${ruleText(r)}`, severity: 'medium' });
  for (const r of a) if (!is.has(r.id)) out.push({ area: 'Rules', item: `${set} › ${ruleLabel(r)}`, before: ruleText(r), after: 'removed', severity: 'medium' });
  // Rules in both: each field that changed, and a new place in the order (among the rules in both).
  const common = b.filter((r) => was.has(r.id)).map((r) => r.id);
  const oldOrder = a.filter((r) => is.has(r.id)).map((r) => r.id);
  for (const r of b) {
    const o = was.get(r.id);
    if (!o) continue;
    const item = `${set} › ${ruleLabel(r)}`;
    if (o.enabled !== r.enabled) out.push({ area: 'Rules', item, before: o.enabled ? 'on' : 'off', after: r.enabled ? 'on' : 'off', severity: 'medium' });
    if (o.action !== r.action) out.push({ area: 'Rules', item: `${item} › action`, before: o.action || '—', after: r.action || '—', severity: 'medium' });
    if (o.expression !== r.expression) out.push({ area: 'Rules', item: `${item} › expression`, before: o.expression || '—', after: r.expression || '—', severity: 'medium' });
    if (o.description !== r.description) out.push({ area: 'Rules', item: `${set} › ${ruleLabel(o)} › name`, before: o.description || '—', after: r.description || '—', severity: 'low' });
    if (o.params !== r.params) {
      for (const f of fieldChanges(o.params || '{}', r.params || '{}')) out.push({ area: 'Rules', item: `${item} › ${f.path || 'settings'}`, before: f.before, after: f.after, severity: 'medium' });
    }
    const from = oldOrder.indexOf(r.id), to = common.indexOf(r.id);
    if (from !== to) out.push({ area: 'Rules', item: `${item} › order`, before: `position ${from + 1}`, after: `position ${to + 1}`, severity: 'low' });
  }
  return out;
}

/** "name TTL class type value" → its parts (null: not a record line). */
function record(line: string): { key: string; label: string; ttl: string; value: string } | null {
  const t = line.split(' ');
  let i = 1;
  const ttl = /^\d+$/.test(t[i] ?? '') ? t[i++] : '';
  if (/^(IN|CH|HS)$/i.test(t[i] ?? '')) i++;
  const type = (t[i++] ?? '').toUpperCase();
  if (!type || i > t.length) return null;
  const name = (t[0] ?? '').toLowerCase();
  return { key: `${name} ${type}`, label: `${type} ${name}`, ttl, value: t.slice(i).join(' ') };
}

function dnsChanges(base: ZoneSnapshot, now: ZoneSnapshot): Change[] {
  return dnsChangesOf(base, now).map((c) => ({ ...c, ref: { kind: 'dns', name: c.item.replace(/ › proxy$/, '').split(' ').slice(1).join(' ') || c.item } }));
}

function dnsChangesOf(base: ZoneSnapshot, now: ZoneSnapshot): Change[] {
  const out: Change[] = [];
  if (!Array.isArray(base.dns) || !Array.isArray(now.dns)) return out;
  const proxyKnown = Array.isArray(base.dnsProxied) && Array.isArray(now.dnsProxied);
  const pa = new Set(base.dnsProxied ?? []), pb = new Set(now.dnsProxied ?? []);
  const proxy = (set: Set<string>, l: string) => (proxyKnown ? (set.has(l) ? ' · proxied' : ' · DNS only') : '');
  const show = (r: NonNullable<ReturnType<typeof record>>, set: Set<string>, l: string) => `${r.value}${r.ttl ? ` · TTL ${r.ttl === '1' ? 'auto' : r.ttl}` : ''}${proxy(set, l)}`;
  const was = new Set(base.dns), is = new Set(now.dns);
  const removed = base.dns.filter((l) => !is.has(l)), added = now.dns.filter((l) => !was.has(l));
  // A record removed and one added with the same name and type: that record changed (its value, TTL or proxy).
  const byKey = new Map<string, { removed: string[]; added: string[] }>();
  for (const [list, side] of [[removed, 'removed'], [added, 'added']] as const) {
    for (const l of list) {
      const k = record(l)?.key ?? l;
      const e = byKey.get(k) ?? { removed: [], added: [] };
      e[side].push(l);
      byKey.set(k, e);
    }
  }
  for (const { removed: rs, added: as } of byKey.values()) {
    const n = Math.min(rs.length, as.length);
    for (let i = 0; i < n; i++) {
      const a = record(rs[i])!, b = record(as[i])!;
      out.push({ area: 'DNS', item: b.label, before: show(a, pa, rs[i]), after: show(b, pb, as[i]), severity: proxyKnown && pa.has(rs[i]) && !pb.has(as[i]) ? 'medium' : 'low' });
    }
    for (const l of as.slice(n)) { const r = record(l); out.push({ area: 'DNS', item: r?.label ?? l, before: '—', after: r ? `added: ${show(r, pb, l)}` : 'added', severity: 'low' }); }
    for (const l of rs.slice(n)) { const r = record(l); out.push({ area: 'DNS', item: r?.label ?? l, before: r ? show(r, pa, l) : 'present', after: 'removed', severity: 'low' }); }
  }
  // The same record, proxied before and not now (or the other way round). Turning the proxy off shows the origin's address.
  if (proxyKnown) {
    for (const l of now.dns) {
      if (!was.has(l) || pa.has(l) === pb.has(l)) continue;
      const r = record(l);
      out.push({ area: 'DNS', item: `${r?.label ?? l} › proxy`, before: pa.has(l) ? 'proxied' : 'DNS only', after: pb.has(l) ? 'proxied' : 'DNS only', severity: pa.has(l) ? 'medium' : 'low' });
    }
  }
  return out;
}

/** Every change from `base` to `now`. What either snapshot could not read is not compared. */
export function diffSnapshots(base: ZoneSnapshot, now: ZoneSnapshot): Change[] {
  const out: Change[] = [];
  for (const id of new Set([...Object.keys(base.settings), ...Object.keys(now.settings)])) {
    const a = base.settings[id], b = now.settings[id];
    if (a === undefined || b === undefined || a === b) continue;
    const severity: Severity = SECURITY_SETTINGS.has(id) ? 'medium' : 'low';
    for (const f of fieldChanges(a, b)) out.push({ area: 'Setting', item: f.path ? `${id}.${f.path}` : id, before: f.before, after: f.after, severity, ref: { kind: 'setting', id } });
  }
  for (const id of new Set([...Object.keys(base.rulesets), ...Object.keys(now.rulesets)])) {
    const a = base.rulesets[id], b = now.rulesets[id];
    const name = (b ?? a)!.name || (b ?? a)!.phase;
    const ref: ChangeRef = { kind: 'ruleset', id, phase: (b ?? a)!.phase };
    const count = (r: RulesetSnap) => (r.rules ? `, ${r.rules.length} rule${r.rules.length === 1 ? '' : 's'}` : '');
    if (!a) out.push({ area: 'Rules', item: name, before: '—', after: `ruleset added (version ${b!.version}${count(b!)})`, severity: 'medium', ref });
    else if (!b) out.push({ area: 'Rules', item: name, before: `version ${a.version}${count(a)}`, after: 'ruleset removed', severity: 'medium', ref });
    else if (a.version !== b.version) {
      const rules = a.rules && b.rules ? ruleChanges(name, a.rules, b.rules) : null;
      // Without the rules of both (a baseline from before they were kept), only the version is known.
      if (rules?.length) out.push(...rules.map((c) => ({ ...c, ref })));
      else out.push({ area: 'Rules', item: name, before: `version ${a.version}`, after: `version ${b.version}${rules ? ' (saved again, no rule changed)' : ' (rule details are compared from the next accepted baseline)'}`, severity: rules ? 'low' : 'medium', ref });
    }
  }
  out.push(...dnsChanges(base, now));
  if (base.dnssec !== now.dnssec && base.dnssec && now.dnssec) out.push({ area: 'DNSSEC', item: 'status', before: base.dnssec, after: now.dnssec, severity: 'medium', ref: { kind: 'dnssec' } });
  return out;
}

/**
 * Fills in what the baseline could not keep when it was taken, from a newer snapshot where that is
 * safe: DNS records and DNSSEC not read then, proxy status (kept since this version), and the rules of a
 * ruleset whose version has not changed since. Returns null when there is nothing to fill in.
 */
export function completeBaseline(base: ZoneSnapshot, now: ZoneSnapshot): ZoneSnapshot | null {
  let changed = false;
  const next: ZoneSnapshot = { ...base, rulesets: { ...base.rulesets } };
  if (base.dns == null && now.dns) { next.dns = now.dns; next.dnsProxied = now.dnsProxied ?? null; changed = true; }
  else if (base.dnsProxied == null && Array.isArray(now.dnsProxied) && Array.isArray(base.dns)) {
    // Proxy status is watched from the first read that has it: the baseline's records as they are proxied now.
    const lines = new Set(base.dns);
    next.dnsProxied = now.dnsProxied.filter((l) => lines.has(l));
    changed = true;
  }
  if (base.dnssec == null && now.dnssec != null) { next.dnssec = now.dnssec; changed = true; }
  for (const [id, r] of Object.entries(base.rulesets)) {
    const n = now.rulesets[id];
    if (!r.rules && n?.rules && n.version === r.version) { next.rulesets[id] = { ...r, rules: n.rules }; changed = true; }
  }
  return changed ? next : null;
}

const pathOf = (uri: string) => uri.replace(/^https?:\/\/[^/]+/, '').split('?')[0].replace(/\/+$/, '');
const bare = (name: string) => name.trim().replace(/\.$/, '').toLowerCase();

/** Whether an audit-log entry is a change to what `ref` names. */
function touches(ref: ChangeRef, e: AuditTrail): boolean {
  const path = pathOf(e.uri);
  switch (ref.kind) {
    case 'setting': return new RegExp(`/settings/${ref.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(path) || /\/zones\/[^/]+\/settings$/.test(path);
    case 'ruleset': return path.includes(`/rulesets/${ref.id}`) || (!!ref.phase && path.includes(`/rulesets/phases/${ref.phase}/entrypoint`));
    case 'dns': return path.includes('/dns_records') && (!e.target || bare(e.target) === bare(ref.name));
    case 'dnssec': return path.endsWith('/dnssec');
  }
}

/** Who made a change: the newest audit-log entry since the baseline that touches it (null: not in the log kept). */
export function whoChanged(c: Change, trail: AuditTrail[], since: string): AuditTrail | null {
  if (!c.ref) return null;
  const from = Date.parse(since);
  let best: AuditTrail | null = null;
  for (const e of trail) {
    const t = Date.parse(e.time);
    if (!Number.isFinite(t) || (Number.isFinite(from) && t < from) || !touches(c.ref, e)) continue;
    if (!best || t > Date.parse(best.time)) best = e;
  }
  return best;
}

/** A zone's audit trail with newer entries added: the newest `max`, none older than `keepMs`. */
export function mergeTrail(old: AuditTrail[] | undefined, add: AuditTrail[], now = Date.now(), keepMs = 35 * 86_400_000, max = 60): AuditTrail[] {
  const seen = new Set<string>();
  return [...(old ?? []), ...add]
    .filter((e) => { const k = `${e.time}|${e.uri}|${e.who}|${e.target}`; if (seen.has(k)) return false; seen.add(k); return now - Date.parse(e.time) <= keepMs; })
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .slice(0, max);
}
