// The zone search index and comparisons, the pure part: cf-terraforming output (HCL literals), drift
// snapshots and monitoring rows become flat rows of "where" and "what" (a DNS record and its content,
// a setting and its value, a rule's expression …), and two sets of them are compared. Shared by the
// server and tests — no Node imports.

export type IndexKind = 'dns' | 'setting' | 'rule' | 'header' | 'redirect' | 'pagerule' | 'worker_route' | 'certificate' | 'hostname' | 'script' | 'api' | 'resource';

export const INDEX_KINDS: { kind: IndexKind; label: string }[] = [
  { kind: 'dns', label: 'DNS records' },
  { kind: 'setting', label: 'Settings' },
  { kind: 'rule', label: 'Rules' },
  { kind: 'header', label: 'Headers' },
  { kind: 'redirect', label: 'Redirects' },
  { kind: 'pagerule', label: 'Page Rules' },
  { kind: 'worker_route', label: 'Worker routes' },
  { kind: 'certificate', label: 'Certificates' },
  { kind: 'hostname', label: 'Custom hostnames' },
  { kind: 'script', label: 'Scripts and connections' },
  { kind: 'api', label: 'API endpoints' },
  { kind: 'resource', label: 'Other configuration' },
];
export const isIndexKind = (v: unknown): v is IndexKind => typeof v === 'string' && INDEX_KINDS.some((k) => k.kind === v);

/**
 * One searchable fact about a zone. `item` names the same thing in every zone (the zone name and
 * Cloudflare IDs left out: "dns:A:www", "setting:ssl", "ruleset:http_request_firewall_custom:3:expression"),
 * so zones can be compared; `path` is how it is shown ("DNS A www.example.com"); `subject` is what it
 * belongs to (the record name, the setting, the header name); `value` is what it is set to.
 */
export interface IndexRow { kind: IndexKind; item: string; path: string; subject: string; value: string }

/** Longest value kept (a long expression or a snippet is cut, still found by what it starts with). */
export const MAX_VALUE = 4000;

// ── HCL literals (cf-terraforming output) ───────────────────────────────────

export type HclValue = string | number | boolean | null | HclValue[] | { [k: string]: HclValue };
export interface HclResource { type: string; label: string; body: Record<string, HclValue> }

interface Cursor { s: string; i: number }

function skipSpace(p: Cursor, commas = true) {
  const { s } = p;
  while (p.i < s.length) {
    const c = s[p.i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || (commas && c === ',')) p.i++;
    else if (c === '#' || (c === '/' && s[p.i + 1] === '/')) { while (p.i < s.length && s[p.i] !== '\n') p.i++; }
    else if (c === '/' && s[p.i + 1] === '*') { const end = s.indexOf('*/', p.i + 2); p.i = end < 0 ? s.length : end + 2; }
    else break;
  }
}

function readString(p: Cursor): string {
  const { s } = p;
  p.i++; // opening quote
  let out = '';
  while (p.i < s.length) {
    const c = s[p.i];
    if (c === '"') { p.i++; return out; }
    if (c === '\n') throw new Error('unterminated string');
    if (c === '\\') {
      const n = s[p.i + 1];
      if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(p.i + 2, p.i + 6))) { out += String.fromCharCode(parseInt(s.slice(p.i + 2, p.i + 6), 16)); p.i += 6; continue; }
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n ?? '';
      p.i += 2;
      continue;
    }
    // Template escapes: $${ and %%{ are a literal ${ and %{.
    if ((c === '$' || c === '%') && s[p.i + 1] === c && s[p.i + 2] === '{') { out += `${c}{`; p.i += 3; continue; }
    out += c;
    p.i++;
  }
  throw new Error('unterminated string');
}

function readHeredoc(p: Cursor): string {
  const m = /^<<(-?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*\n/.exec(p.s.slice(p.i, p.i + 200));
  if (!m) throw new Error('bad heredoc');
  p.i += m[0].length;
  const lines: string[] = [];
  while (p.i < p.s.length) {
    const nl = p.s.indexOf('\n', p.i);
    const line = p.s.slice(p.i, nl < 0 ? p.s.length : nl);
    p.i = nl < 0 ? p.s.length : nl + 1;
    if (line.trim() === m[2]) {
      if (!m[1]) return lines.join('\n');
      const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
      return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
    }
    lines.push(line);
  }
  throw new Error('unterminated heredoc');
}

/** A bare value: a number, true / false / null, or an expression kept as its text (a reference, a function call). */
function readBare(p: Cursor): HclValue {
  const { s } = p;
  const start = p.i;
  let depth = 0;
  while (p.i < s.length) {
    const c = s[p.i];
    if (c === '"') { readString(p); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (!depth) break; depth--; }
    else if ((c === '\n' || c === ',') && !depth) break;
    p.i++;
  }
  const raw = s.slice(start, p.i).trim();
  if (!raw) throw new Error('missing value');
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function readValue(p: Cursor): HclValue {
  skipSpace(p, false);
  const c = p.s[p.i];
  if (c === '"') return readString(p);
  if (c === '<' && p.s[p.i + 1] === '<') return readHeredoc(p);
  if (c === '[') {
    p.i++;
    const list: HclValue[] = [];
    for (;;) {
      skipSpace(p);
      if (p.i >= p.s.length) throw new Error('unterminated list');
      if (p.s[p.i] === ']') { p.i++; return list; }
      list.push(readValue(p));
    }
  }
  if (c === '{') { p.i++; return readBody(p); }
  return readBare(p);
}

/** The attributes and blocks up to the closing brace (already past the opening one). */
function readBody(p: Cursor): Record<string, HclValue> {
  const obj: Record<string, HclValue> = {};
  for (;;) {
    skipSpace(p);
    if (p.i >= p.s.length) throw new Error('unterminated block');
    if (p.s[p.i] === '}') { p.i++; return obj; }
    let key: string;
    if (p.s[p.i] === '"') key = readString(p);
    else {
      const m = /^[A-Za-z0-9_.\-]+/.exec(p.s.slice(p.i, p.i + 300));
      if (!m) throw new Error(`unexpected "${p.s[p.i]}"`);
      key = m[0];
      p.i += key.length;
    }
    skipSpace(p, false);
    if (p.s[p.i] === '=' || p.s[p.i] === ':') { p.i++; obj[key] = readValue(p); continue; }
    // A nested block (`settings {`, `rule "label" {`): repeated blocks become a list.
    const labels: string[] = [];
    while (p.s[p.i] === '"') { labels.push(readString(p)); skipSpace(p, false); }
    if (p.s[p.i] !== '{') throw new Error(`expected = or { after ${key}`);
    p.i++;
    let v: HclValue = readBody(p);
    for (const l of labels.reverse()) v = { [l]: v };
    const had = obj[key];
    obj[key] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
  }
}

/** The `resource "type" "label" { … }` blocks of a file; a block that cannot be read is left out. */
export function parseHcl(text: string): HclResource[] {
  const s = text.replace(/\r\n/g, '\n');
  const out: HclResource[] = [];
  const re = /^resource\s+"([A-Za-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const p: Cursor = { s, i: m.index + m[0].length };
    try {
      out.push({ type: m[1], label: m[2], body: readBody(p) });
      re.lastIndex = p.i;
    } catch { /* not a literal block: skipped */ }
  }
  return out;
}

// ── Flattening ──────────────────────────────────────────────────────────────

/** Attribute names whose values are never indexed or shown (secrets a backup may hold). */
const SECRET = /(secret|password|passwd|private_?key|api_?key|access_key|token|psk|credential|signing_key|key_pem|^key$|^certificate$|^pem$)/i;
/** Bookkeeping that differs between zones and backups without meaning anything. */
const NOISE = new Set(['zone_id', 'account_id', 'ref', 'last_updated', 'version', 'created_on', 'modified_on', 'created_at', 'modified_at', 'updated_at', 'etag']);

const leafName = (path: string) => path.replace(/\[\d+\]/g, '').split('.').pop() ?? path;

/** Stable text for a value: strings as they are, everything else as JSON with sorted keys. */
export function canon(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x);
  return JSON.stringify(sort(v));
}

/** [path, value] of every scalar under `v` (lists of scalars as one value, comma-separated). */
export function leaves(v: HclValue | undefined, path = '', out: [string, string][] = []): [string, string][] {
  if (v === null || v === undefined) return out;
  const name = leafName(path);
  if (path && NOISE.has(name)) return out;
  if (path && typeof v !== 'object' && SECRET.test(name)) return out;
  if (Array.isArray(v)) {
    if (path && SECRET.test(name) && v.every((x) => x === null || typeof x !== 'object')) return out;
    if (v.every((x) => x === null || typeof x !== 'object')) { if (v.length) out.push([path, v.filter((x) => x !== null).map(String).join(', ')]); return out; }
    v.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
    return out;
  }
  if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out);
    return out;
  }
  out.push([path, String(v)]);
  return out;
}

const cut = (v: string) => (v.length > MAX_VALUE ? v.slice(0, MAX_VALUE) : v);
const lc = (v: string) => v.toLowerCase().replace(/\.$/, '');

/** A name relative to the zone: "@" for the apex, "www" for www.example.com, other names as they are. */
export function relName(name: string, zone: string): string {
  const n = lc(name.trim()), z = lc(zone);
  if (!n || n === z || n === '@') return '@';
  return n.endsWith(`.${z}`) ? n.slice(0, -z.length - 1) : n;
}

/** The zone's own name in a value, as {zone} (so two zones' values can be compared). */
export function normZone(value: string, zone: string): string {
  if (!zone) return value;
  const esc = zone.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`(^|[^a-z0-9-])${esc}(?![a-z0-9-])`, 'gi'), '$1{zone}');
}

const str = (v: HclValue | undefined) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/** Account-level configuration found in a zone's folder (Zero Trust, Spectrum …): not the zone's. */
export function zoneLevel(r: HclResource): boolean {
  if (/^cloudflare_(zero_trust_|spectrum_|account|api_token|user|email_routing_dns$)/.test(r.type)) return false;
  return !(r.body.account_id !== undefined && r.body.zone_id === undefined);
}

/** What names one resource of a type within a zone, across backups (not its label: it carries an ID). */
const IDENT = ['setting_id', 'name', 'identifier', 'hostname', 'pattern', 'phase', 'type', 'host'];
export function identOf(r: HclResource): string {
  for (const k of IDENT) { const v = str(r.body[k]); if (v) return v; }
  return '';
}

/** The rows of one backup resource. */
export function resourceRows(r: HclResource, zone: string): IndexRow[] {
  const b = r.body;
  const short = r.type.replace(/^cloudflare_/, '');
  const out: IndexRow[] = [];
  const push = (row: IndexRow) => { if (row.value !== '') out.push({ ...row, value: cut(row.value) }); };
  switch (r.type) {
    case 'cloudflare_dns_record':
    case 'cloudflare_record': {
      const type = str(b.type).toUpperCase(), name = str(b.name) || zone;
      const full = name.includes('.') || name === '@' ? (name === '@' ? zone : name) : `${name}.${zone}`;
      let value = str(b.content) || str(b.value);
      if (!value && b.data && typeof b.data === 'object') value = leaves(b.data).map(([k, v]) => `${k}=${v}`).join(' ');
      push({ kind: 'dns', item: `dns:${type}:${relName(full, zone)}`, path: `DNS ${type} ${lc(full)}`, subject: lc(full), value: dnsValue(type, value) });
      return out;
    }
    case 'cloudflare_zone_setting': {
      const id = str(b.setting_id);
      if (!id) return out;
      push({ kind: 'setting', item: `setting:${id}`, path: `Setting ${id}`, subject: id, value: settingValue(b.value) });
      return out;
    }
    case 'cloudflare_ruleset': {
      const phase = str(b.phase) || str(b.name) || 'ruleset';
      const rules = Array.isArray(b.rules) ? b.rules : [];
      rules.forEach((rule, i) => {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return;
        const n = i + 1;
        const subject = str(rule.description) || `${phase} rule ${n}`;
        for (const [p, v] of leaves(rule)) {
          if (p === 'id') continue;
          const header = /^action_parameters\.headers\.([^.[]+)(?:\.(.+))?$/.exec(p);
          const item = `ruleset:${phase}:${n}:${p}`;
          if (header && header[1]) push({ kind: 'header', item, path: `Ruleset ${phase} rule ${n} header ${header[1]}${header[2] ? ` ${header[2]}` : ''}`, subject: header[1], value: v });
          else if (/target_url|from_list|forwarding_url/.test(p)) push({ kind: 'redirect', item, path: `Ruleset ${phase} rule ${n} ${p}`, subject, value: v });
          else push({ kind: 'rule', item, path: `Ruleset ${phase} rule ${n} ${p}`, subject, value: v });
        }
      });
      return out;
    }
    case 'cloudflare_page_rule': {
      const prio = str(b.priority) || '?';
      const target = str(b.target) || str((b.targets as HclValue[] | undefined)?.[0] as HclValue);
      push({ kind: 'pagerule', item: `pagerule:${prio}:target`, path: `Page Rule ${prio} target`, subject: target, value: target });
      for (const [p, v] of leaves(b.actions)) push({ kind: /forwarding_url\.url$/.test(p) ? 'redirect' : 'pagerule', item: `pagerule:${prio}:${p}`, path: `Page Rule ${prio} ${p}`, subject: target, value: v });
      if (b.status !== undefined) push({ kind: 'pagerule', item: `pagerule:${prio}:status`, path: `Page Rule ${prio} status`, subject: target, value: str(b.status) });
      return out;
    }
    case 'cloudflare_workers_route':
    case 'cloudflare_worker_route': {
      const pattern = str(b.pattern);
      push({ kind: 'worker_route', item: `worker_route:${normZone(pattern.toLowerCase(), zone)}`, path: `Worker route${str(b.script) ? ` → ${str(b.script)}` : ''}`, subject: str(b.script), value: pattern });
      return out;
    }
    case 'cloudflare_certificate_pack': {
      const hosts = Array.isArray(b.hosts) ? b.hosts.map(str).filter(Boolean) : [];
      const type = str(b.type) || 'certificate';
      for (const h of hosts) push({ kind: 'certificate', item: `certificate:${type}:${relName(h, zone)}`, path: `Certificate pack ${type} host`, subject: type, value: lc(h) });
      return out;
    }
    case 'cloudflare_custom_hostname': {
      const h = str(b.hostname);
      push({ kind: 'hostname', item: `hostname:${lc(h)}`, path: 'Custom hostname', subject: lc(h), value: lc(h) });
      for (const [p, v] of leaves(b)) if (p !== 'hostname') push({ kind: 'hostname', item: `hostname:${lc(h)}:${p}`, path: `Custom hostname ${lc(h)} ${p}`, subject: lc(h), value: v });
      return out;
    }
    default: {
      const ident = identOf(r);
      const key = ident ? relName(ident, zone) : '-';
      for (const [p, v] of leaves(b)) {
        if (p === 'id') continue;
        push({ kind: 'resource', item: `${short}:${key}:${p}`, path: `${short}${ident ? ` ${ident}` : ''} ${p}`, subject: ident || short, value: v });
      }
      return out;
    }
  }
}

/** DNS content the same way from every source: no quotes around TXT, no trailing dot on names. */
export function dnsValue(type: string, value: string): string {
  let v = value.trim();
  if (type === 'TXT' && /^".*"$/s.test(v)) v = v.replace(/"\s+"/g, '').slice(1, -1);
  if (['CNAME', 'NS', 'PTR', 'MX'].includes(type)) v = v.replace(/\.$/, '').toLowerCase();
  return v;
}

function settingValue(v: HclValue | undefined): string {
  return typeof v === 'string' ? v : canon(v);
}

/** Every row of one zone's backup files (provider, import and manifest files left out). */
export function backupRows(files: { name: string; text: string }[], zone: string): IndexRow[] {
  return files.filter((f) => f.name.endsWith('.tf') && !['provider.tf', 'imports.tf', '_backup_manifest.tf'].includes(f.name))
    .flatMap((f) => parseHcl(f.text)).filter(zoneLevel).flatMap((r) => resourceRows(r, zone));
}

/** The zone and account a backup's files name (cloudflare_zone, or any zone_id), when they do. */
export function backupZone(files: { name: string; text: string }[]): { zoneId: string | null; accountId: string | null } {
  let zoneId: string | null = null, accountId: string | null = null;
  for (const f of files) {
    if (!zoneId) zoneId = /^\s*zone_id\s*=\s*"([0-9a-f]{32})"/m.exec(f.text)?.[1] ?? null;
    if (f.name === 'cloudflare_zone.tf') {
      const z = parseHcl(f.text)[0];
      if (z) {
        zoneId = /^terraform_managed_resource_([0-9a-f]{32})/.exec(z.label)?.[1] ?? zoneId;
        const acct = z.body.account;
        accountId = acct && typeof acct === 'object' && !Array.isArray(acct) ? str(acct.id) || null : null;
      }
    }
  }
  return { zoneId, accountId };
}

// ── Drift snapshots and monitoring rows ─────────────────────────────────────

export interface SnapshotLike {
  settings?: Record<string, string>;
  rulesets?: Record<string, { name: string; phase: string; version: string }>;
  dns?: string[] | null;
  dnssec?: string | null;
}

/** The rows of a drift snapshot (settings, rulesets, DNS records, DNSSEC). */
export function snapshotRows(s: SnapshotLike, zone: string): IndexRow[] {
  const out: IndexRow[] = [];
  for (const [id, raw] of Object.entries(s.settings ?? {})) {
    let v = raw;
    try { if (/^[{["]/.test(raw)) v = settingValue(JSON.parse(raw) as HclValue); } catch { /* text as it is */ }
    out.push({ kind: 'setting', item: `setting:${id}`, path: `Setting ${id}`, subject: id, value: cut(v) });
  }
  for (const r of Object.values(s.rulesets ?? {})) {
    const phase = r.phase || r.name;
    if (phase) out.push({ kind: 'rule', item: `ruleset:${phase}:present`, path: `Ruleset ${phase}`, subject: phase, value: r.name || phase });
  }
  for (const line of s.dns ?? []) {
    const d = parseDnsLine(line);
    if (d) out.push({ kind: 'dns', item: `dns:${d.type}:${relName(d.name, zone)}`, path: `DNS ${d.type} ${d.name}`, subject: d.name, value: cut(d.value) });
  }
  if (s.dnssec) out.push({ kind: 'setting', item: 'setting:dnssec', path: 'DNSSEC', subject: 'dnssec', value: s.dnssec });
  return out;
}

const DNS_CLASSES = new Set(['IN', 'CH', 'HS']);
/** "www.example.com. 300 IN A 192.0.2.1" (Cloudflare's BIND export, as the drift check keeps it). */
export function parseDnsLine(line: string): { name: string; type: string; value: string } | null {
  const t = line.trim().split(/\s+/);
  if (t.length < 3) return null;
  const name = lc(t[0]);
  let i = 1;
  if (/^\d+$/.test(t[i] ?? '')) i++;
  if (DNS_CLASSES.has((t[i] ?? '').toUpperCase())) i++;
  const type = (t[i] ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(type)) return null;
  let value = t.slice(i + 1).join(' ');
  if (type === 'MX') value = value.replace(/^\d+\s+/, '');
  return { name, type, value: dnsValue(type, value) };
}

type MonitorRow = Record<string, unknown>;
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** The rows of a monitoring check's zone result worth finding (Page Rules, certificates, scripts …). */
export function monitorRows(check: string, sections: Partial<Record<string, MonitorRow[]>>, zone: string): IndexRow[] {
  const out: IndexRow[] = [];
  const add = (row: IndexRow) => { if (row.value) out.push({ ...row, value: cut(row.value) }); };
  if (check === 'pagerules') {
    for (const r of sections.rules ?? []) {
      const url = text(r.url);
      add({ kind: 'pagerule', item: `pagerule:url:${normZone(url.toLowerCase(), zone)}`, path: 'Page Rule target', subject: url, value: url });
      const setting = text(r.setting);
      if (setting) add({ kind: setting === 'forwarding_url' ? 'redirect' : 'pagerule', item: `pagerule:url:${normZone(url.toLowerCase(), zone)}:${setting}`, path: `Page Rule ${setting}`, subject: url, value: text(r.value) });
    }
  } else if (check === 'certificates') {
    for (const r of sections.certificates ?? []) {
      for (const h of text(r.name).split(/,\s*/).filter(Boolean)) add({ kind: 'certificate', item: `certificate:${text(r.kind)}:${relName(h, zone)}`, path: `Certificate ${text(r.kind)}`, subject: text(r.kind), value: h.toLowerCase() });
    }
  } else if (check === 'appsec') {
    for (const r of sections.scripts ?? []) add({ kind: 'script', item: `script:${text(r.url)}`, path: 'Page Shield script', subject: text(r.url), value: text(r.url) });
    for (const r of sections.connections ?? []) add({ kind: 'script', item: `connection:${text(r.url)}`, path: 'Page Shield connection', subject: text(r.url), value: text(r.url) });
    for (const r of sections.apis ?? []) add({ kind: 'api', item: `api:${text(r.method)}:${normZone(text(r.endpoint), zone)}`, path: `API endpoint (${text(r.state)})`, subject: text(r.method), value: `${text(r.method)} ${text(r.endpoint)}`.trim() });
  } else if (check === 'availability') {
    for (const r of sections.status ?? []) add({ kind: 'resource', item: `${text(r.kind).toLowerCase().replace(/\s+/g, '_')}:${text(r.name)}`, path: `${text(r.kind)} ${text(r.name)}`, subject: text(r.name), value: text(r.target) });
  }
  return out;
}

/** Checks whose zone rows are indexed (drift indexes its snapshot instead). */
export const INDEXED_CHECKS = new Set(['pagerules', 'certificates', 'appsec', 'availability', 'drift']);

// ── Comparisons ─────────────────────────────────────────────────────────────

export interface AttrChange { path: string; before: string | null; after: string | null }
export interface ResourceChange { key: string; type: string; name: string; change: 'added' | 'removed' | 'changed'; attrs: AttrChange[] }

/** Names one resource across two backups of the same zone (its type and Cloudflare ID, or what identifies it). */
function resourceKey(r: HclResource): string {
  const id = r.label.replace(/^terraform_managed_resource_/, '').replace(/_\d+$/, '');
  return `${r.type}:${id || identOf(r) || r.label}`;
}

/** What changed between two backups of one zone, resource by resource and attribute by attribute. */
export function diffBackups(before: { name: string; text: string }[], after: { name: string; text: string }[]): { changes: ResourceChange[]; unchanged: number } {
  const parse = (files: { name: string; text: string }[]) => {
    const m = new Map<string, HclResource>();
    for (const r of files.filter((f) => f.name.endsWith('.tf') && !['provider.tf', 'imports.tf', '_backup_manifest.tf'].includes(f.name)).flatMap((f) => parseHcl(f.text))) {
      let k = resourceKey(r);
      for (let n = 2; m.has(k); n++) k = `${resourceKey(r)}#${n}`;
      m.set(k, r);
    }
    return m;
  };
  const a = parse(before), b = parse(after);
  const changes: ResourceChange[] = [];
  let unchanged = 0;
  const flat = (r: HclResource) => new Map(leaves(r.body).filter(([p]) => p !== 'id'));
  for (const [k, ra] of a) {
    const rb = b.get(k);
    const name = identOf(ra) || ra.label;
    if (!rb) { changes.push({ key: k, type: ra.type, name, change: 'removed', attrs: [...flat(ra)].map(([path, v]) => ({ path, before: v, after: null })) }); continue; }
    const fa = flat(ra), fb = flat(rb);
    const attrs: AttrChange[] = [];
    for (const [p, v] of fa) if (fb.get(p) !== v) attrs.push({ path: p, before: v, after: fb.get(p) ?? null });
    for (const [p, v] of fb) if (!fa.has(p)) attrs.push({ path: p, before: null, after: v });
    if (attrs.length) changes.push({ key: k, type: ra.type, name: identOf(rb) || name, change: 'changed', attrs });
    else unchanged++;
  }
  for (const [k, rb] of b) if (!a.has(k)) changes.push({ key: k, type: rb.type, name: identOf(rb) || rb.label, change: 'added', attrs: [...flat(rb)].map(([path, v]) => ({ path, before: null, after: v })) });
  const order = { removed: 0, changed: 1, added: 2 };
  changes.sort((x, y) => x.type.localeCompare(y.type) || order[x.change] - order[y.change] || x.name.localeCompare(y.name));
  return { changes, unchanged };
}

export interface StoredRow extends IndexRow { source: string; sourceAt: string }
export interface ItemDiff { item: string; kind: IndexKind; path: string; a: string[]; b: string[]; status: 'only-a' | 'only-b' | 'different' }

/**
 * Each item's values in a zone, the zone's name written as {zone}. Where two sources have the same
 * item (a backup and the drift snapshot), the newest one counts.
 */
export function itemValues(rows: StoredRow[], zone: string): Map<string, { kind: IndexKind; path: string; values: string[]; at: string }> {
  const out = new Map<string, { kind: IndexKind; path: string; values: string[]; at: string; source: string }>();
  for (const r of rows) {
    const v = normZone(r.value, zone);
    const had = out.get(r.item);
    if (!had || r.sourceAt > had.at) out.set(r.item, { kind: r.kind, path: normZone(r.path, zone), values: [v], at: r.sourceAt, source: r.source });
    else if (had.source === r.source && had.at === r.sourceAt && !had.values.includes(v)) had.values.push(v);
  }
  for (const x of out.values()) x.values.sort();
  return out;
}

/** Two zones side by side: what only one has, and what both have with other values. */
export function diffZones(a: StoredRow[], aZone: string, b: StoredRow[], bZone: string): { diffs: ItemDiff[]; same: number } {
  const va = itemValues(a, aZone), vb = itemValues(b, bZone);
  const diffs: ItemDiff[] = [];
  let same = 0;
  for (const [item, x] of va) {
    const y = vb.get(item);
    if (!y) diffs.push({ item, kind: x.kind, path: x.path, a: x.values, b: [], status: 'only-a' });
    else if (x.values.join('\n') !== y.values.join('\n')) diffs.push({ item, kind: x.kind, path: x.path, a: x.values, b: y.values, status: 'different' });
    else same++;
  }
  for (const [item, y] of vb) if (!va.has(item)) diffs.push({ item, kind: y.kind, path: y.path, a: [], b: y.values, status: 'only-b' });
  diffs.sort((p, q) => p.kind.localeCompare(q.kind) || p.item.localeCompare(q.item));
  return { diffs, same };
}

// ── Templates ───────────────────────────────────────────────────────────────

export type TemplateMatch = 'equals' | 'contains' | 'present' | 'absent';
export const TEMPLATE_MATCHES: TemplateMatch[] = ['equals', 'contains', 'present', 'absent'];
export interface TemplateItem { item: string; kind: IndexKind; path: string; expected: string; match: TemplateMatch }
export interface Gap { item: string; path: string; expected: string; match: TemplateMatch; actual: string[]; problem: 'missing' | 'different' | 'unexpected' }

export const MAX_TEMPLATE_ITEMS = 500;

/** A template's items from a zone's rows: the kinds chosen (all when none), its name written as {zone}. */
export function templateFrom(rows: StoredRow[], zone: string, kinds: IndexKind[] = [], prefixes: string[] = []): TemplateItem[] {
  const out: TemplateItem[] = [];
  for (const [item, x] of itemValues(rows, zone)) {
    if (kinds.length && !kinds.includes(x.kind)) continue;
    if (prefixes.length && !prefixes.some((p) => item.startsWith(p))) continue;
    out.push({ item, kind: x.kind, path: x.path, expected: x.values[0] ?? '', match: 'equals' });
  }
  return out.sort((p, q) => p.kind.localeCompare(q.kind) || p.item.localeCompare(q.item)).slice(0, MAX_TEMPLATE_ITEMS);
}

/** How a zone differs from a template (only what does not match). */
export function evaluate(items: TemplateItem[], rows: StoredRow[], zone: string): Gap[] {
  const v = itemValues(rows, zone);
  const gaps: Gap[] = [];
  for (const t of items) {
    const actual = v.get(t.item)?.values ?? [];
    const exp = t.expected.trim().toLowerCase();
    const has = (fn: (x: string) => boolean) => actual.some((x) => fn(x.trim().toLowerCase()));
    let problem: Gap['problem'] | null = null;
    if (t.match === 'absent') problem = actual.length ? 'unexpected' : null;
    else if (!actual.length) problem = 'missing';
    else if (t.match === 'equals' && !has((x) => x === exp)) problem = 'different';
    else if (t.match === 'contains' && !has((x) => x.includes(exp))) problem = 'different';
    if (problem) gaps.push({ item: t.item, path: t.path, expected: t.expected, match: t.match, actual: actual.slice(0, 5), problem });
  }
  return gaps;
}

/** Cleans a template item list from a client. */
export function cleanItems(v: unknown): TemplateItem[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: TemplateItem[] = [];
  for (const x of v.slice(0, MAX_TEMPLATE_ITEMS)) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const item = typeof o.item === 'string' ? o.item.trim().slice(0, 300) : '';
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push({
      item, kind: isIndexKind(o.kind) ? o.kind : 'resource',
      path: typeof o.path === 'string' ? o.path.slice(0, 300) : item,
      expected: typeof o.expected === 'string' ? o.expected.slice(0, MAX_VALUE) : '',
      match: TEMPLATE_MATCHES.includes(o.match as TemplateMatch) ? o.match as TemplateMatch : 'equals',
    });
  }
  return out;
}

// ── Search terms ────────────────────────────────────────────────────────────

/** An IPv4 / IPv6 address or CIDR range, as Postgres inet accepts it; null when `q` is not one. */
export function ipQuery(q: string): string | null {
  const t = q.trim();
  const v4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
  const v6 = /^[0-9a-fA-F:]+(:(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3})?(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/;
  if (v4.test(t)) return t;
  if (t.includes(':') && v6.test(t) && (t.match(/::/g) ?? []).length <= 1 && t.split('/')[0].split(':').length <= 8) return t.toLowerCase();
  return null;
}

/** The address a row's value is (A / AAAA content, a health check target), for CIDR search. */
export function rowIp(r: Pick<IndexRow, 'value'>): string | null {
  const ip = ipQuery(r.value);
  return ip && !ip.includes('/') ? ip : null;
}
