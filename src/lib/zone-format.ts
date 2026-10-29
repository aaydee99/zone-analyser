// Zone explorer formatting shared by the page and the download endpoints (no Node imports):
// what a rule's action does, the JSON download and the CSV rows.
import { ZONE_GROUPS, type ZoneReport } from './zone-catalog';

export const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One CSV cell. A text value that a spreadsheet would run as a formula (=, +, @, -x …) is prefixed with '. */
export const csvCell = (v: unknown) => {
  let s = text(v);
  if (typeof v === 'string' && /^[=+@\t\r]|^-[^\d]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** A CSV file with a BOM, so Excel reads it as UTF-8. */
export const csvFile = (rows: unknown[][]) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

/** [field path, value] for every leaf of a value: objects as a.b, arrays as a[0]. */
export function leaves(v: unknown, path = '', out: [string, unknown][] = []): [string, unknown][] {
  if (Array.isArray(v)) {
    if (!v.length) out.push([path, '[]']);
    v.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
  } else if (isObj(v)) {
    const keys = Object.keys(v);
    if (!keys.length) out.push([path, '{}']);
    for (const k of keys) leaves(v[k], path ? `${path}.${k}` : k, out);
  } else out.push([path, v]);
  return out;
}

const val = (v: unknown) => (isObj(v) ? text(v.value ?? (v.expression ? `expr: ${text(v.expression)}` : '')) : text(v));

/** The action parameters the summary reads (Rulesets API: rule.action_parameters). */
interface ActionParams {
  from_value?: { status_code?: number; target_url?: unknown; preserve_query_string?: boolean };
  from_list?: { name?: string };
  uri?: { path?: unknown; query?: unknown };
  headers?: Record<string, Record<string, unknown>>;
  host_header?: string;
  origin?: { host?: string; port?: number };
  sni?: { value?: string };
  id?: string;
  overrides?: unknown;
  ruleset?: string;
  phases?: string[];
  products?: string[];
  rulesets?: string[];
  algorithms?: { name?: string }[];
  status_code?: number;
  content_type?: string;
}

/** What a rule's action does, in the dashboard's terms (redirect target, rewrite, rate, origin …). */
export function actionDetail(r: Record<string, unknown>, names: Record<string, string>): string {
  const p = (isObj(r.action_parameters) ? r.action_parameters : {}) as ActionParams;
  const parts: string[] = [];
  switch (r.action) {
    case 'redirect': {
      const fv = p.from_value ?? {};
      parts.push(`${fv.status_code ?? 301} → ${val(fv.target_url)}`);
      if (fv.preserve_query_string) parts.push('keeps the query string');
      if (p.from_list) parts.push(`list ${text(p.from_list.name)}`);
      break;
    }
    case 'rewrite':
      if (p.uri?.path) parts.push(`path → ${val(p.uri.path)}`);
      if (p.uri?.query) parts.push(`query → ${val(p.uri.query)}`);
      for (const [h, x] of Object.entries(p.headers ?? {})) parts.push(`${x.operation ?? 'set'} ${h}${x.value || x.expression ? ` = ${text(x.value ?? x.expression)}` : ''}`);
      break;
    case 'route':
      if (p.host_header) parts.push(`Host header ${text(p.host_header)}`);
      if (p.origin) parts.push(`origin ${[p.origin.host, p.origin.port].filter(Boolean).join(':')}`);
      if (p.sni) parts.push(`SNI ${text(p.sni.value)}`);
      break;
    case 'execute':
      parts.push(`runs ${(p.id && names[p.id]) || p.id || 'a ruleset'}`);
      if (p.overrides) parts.push(`overrides: ${text(p.overrides)}`);
      break;
    case 'skip':
      if (p.ruleset) parts.push(`skips the rest of this ruleset`);
      if (p.phases) parts.push(`skips phases ${p.phases.join(', ')}`);
      if (p.products) parts.push(`skips ${p.products.join(', ')}`);
      if (p.rulesets) parts.push(`skips rulesets ${p.rulesets.map((x) => names[x] || x).join(', ')}`);
      break;
    case 'compress_response':
      parts.push(`algorithms ${(p.algorithms ?? []).map((x) => x.name).join(', ')}`);
      break;
    case 'serve_error':
      parts.push([p.status_code && `HTTP ${p.status_code}`, p.content_type].filter(Boolean).join(' · '));
      break;
    default:
      if (Object.keys(p).length) parts.push(Object.entries(p).map(([k, v]) => `${k}: ${text(v)}`).join('; '));
  }
  // Rate limiting rules carry their rate on the rule itself.
  const rl = isObj(r.ratelimit) ? (r.ratelimit as Record<string, unknown>) : null;
  if (rl) {
    parts.push(`${text(rl.requests_per_period)} requests / ${text(rl.period)} s per ${((rl.characteristics ?? []) as string[]).join(' + ')}`);
    if (rl.mitigation_timeout) parts.push(`for ${text(rl.mitigation_timeout)} s`);
  }
  return parts.filter(Boolean).join(' · ');
}

/** The JSON download: the zone, then each section in the explorer's order with its rule pages, settings and endpoints. */
export const orderedReport = (report: ZoneReport) => ({
  zone: report.zone,
  generatedAt: report.generatedAt,
  readWith: report.credentialName,
  sections: ZONE_GROUPS.map((g) => ({
    section: g.label,
    rulePages: report.rules.filter((p) => p.area === g.key),
    items: report.sections.filter((s) => s.group === g.key),
  })).filter((x) => x.rulePages.length || x.items.length),
  rulesetNames: report.rulesetNames,
  /** Every certificate, Cloudflare managed or custom, soonest expiry first. */
  certificates: certificatesOf(report.sections).map((c) => ({ ...c, daysLeft: daysLeft(c.expiresOn) })),
});

/** The whole zone as rows (group, section, endpoint, status, item, field, value), in the explorer's section order. */
export function reportRows(report: ZoneReport): unknown[][] {
  const rows: unknown[][] = [['group', 'section', 'endpoint', 'status', 'item', 'field', 'value']];
  const itemName = (x: unknown, i: number) => (isObj(x) ? text(x.name ?? x.id ?? x.hostname ?? x.description ?? '') || `#${i + 1}` : `#${i + 1}`);
  for (const g of ZONE_GROUPS) {
    for (const p of report.rules.filter((x) => x.area === g.key)) {
      const base = [g.label, p.label, `GET /rulesets/phases/${p.phase}/entrypoint`, p.status];
      if (p.status !== 'ok') { rows.push([...base, '', '', p.status === 'empty' ? 'nothing configured' : p.message ?? '']); continue; }
      p.rules.forEach((r, i) => {
        const item = `${i + 1}. ${text(r.description) || text(r.id)}`;
        rows.push([...base, item, 'action detail', actionDetail(r, report.rulesetNames)]);
        rows.push([...base, item, 'applies to', scopeText(ruleScope(r.expression))]);
        for (const [f, v] of leaves(r)) rows.push([...base, item, f, v]);
      });
    }
    for (const s of report.sections.filter((x) => x.group === g.key)) {
      const base = [g.label, s.label, `GET ${s.path}`, s.status];
      if (s.status === 'unavailable' || s.status === 'error') { rows.push([...base, '', '', s.message ?? '']); continue; }
      if (s.status === 'empty') { rows.push([...base, '', '', 'nothing configured']); continue; }
      if (Array.isArray(s.data)) s.data.forEach((x, i) => { for (const [f, v] of leaves(x)) rows.push([...base, itemName(x, i), f, v]); });
      else for (const [f, v] of leaves(s.data)) rows.push([...base, '', f, v]);
      if (s.message) rows.push([...base, '', 'not readable', s.message]);
    }
    if (g.key === 'ssl') {
      // The certificates table: one row per certificate field.
      for (const c of certificatesOf(report.sections)) {
        const base = [g.label, 'Certificates', `listed in ${c.source}`, c.status];
        const left = daysLeft(c.expiresOn);
        for (const [k, v] of [['managed_by', c.managedBy], ['type', c.kind], ['issuer', c.issuer], ['expires_on', c.expiresOn], ['days_left', left ?? '']] as const) rows.push([...base, c.hosts || c.id, k, v]);
      }
    }
  }
  return rows;
}

// ── Certificates ─────────────────────────────────────────────────────────────

/** One certificate of the zone, from whichever SSL/TLS endpoint lists it. */
export interface CertRow {
  /** Where it is listed (section label) and its id there. */
  source: string;
  id: string;
  hosts: string;
  managedBy: 'Cloudflare managed' | 'Custom';
  kind: string;
  issuer: string;
  status: string;
  /** ISO time; '' when Cloudflare has not issued it yet or does not say. */
  expiresOn: string;
}

/** Certificate pack types (Cloudflare API: ssl/certificate_packs type). */
const PACK_KIND: Record<string, [CertRow['managedBy'], string]> = {
  universal: ['Cloudflare managed', 'Universal SSL'],
  advanced: ['Cloudflare managed', 'Advanced certificate'],
  total_tls: ['Cloudflare managed', 'Total TLS'],
  managed_hostname: ['Cloudflare managed', 'Custom hostname certificate'],
  sni_custom: ['Custom', 'Custom certificate (SNI)'],
  legacy_custom: ['Custom', 'Custom certificate (legacy)'],
  mh_custom: ['Custom', 'Custom hostname certificate (uploaded)'],
  keyless: ['Custom', 'Keyless certificate'],
};
const CA_NAME: Record<string, string> = { google: 'Google Trust Services', lets_encrypt: "Let's Encrypt", ssl_com: 'SSL.com', digicert: 'DigiCert' };
const hostsOf = (v: unknown) => (Array.isArray(v) ? v.map(text).join(', ') : text(v));
const list = (sections: { key: string; data?: unknown }[], key: string) => {
  const d = sections.find((s) => s.key === key)?.data;
  return (Array.isArray(d) ? d : []).filter(isObj);
};

/**
 * Every certificate the SSL/TLS endpoints list, as Cloudflare managed or custom, soonest expiry first:
 * edge certificate packs (each certificate in a pack), uploaded custom certificates, custom hostnames,
 * Authenticated Origin Pulls certificates, mTLS client certificates and the custom origin trust store.
 */
export function certificatesOf(sections: { key: string; data?: unknown }[]): CertRow[] {
  const rows: CertRow[] = [];
  const seen = new Set<string>();
  const add = (r: CertRow) => { if (r.id && seen.has(r.id)) return; if (r.id) seen.add(r.id); rows.push(r); };

  // Uploaded custom certificates first: their packs (sni_custom / legacy_custom) list the same certificates.
  for (const c of list(sections, 'custom_certificates')) {
    add({ source: 'Custom certificates', id: text(c.id), hosts: hostsOf(c.hosts), managedBy: 'Custom', kind: `Uploaded certificate${c.bundle_method ? ` (${text(c.bundle_method)} bundle)` : ''}`,
      issuer: text(c.issuer), status: text(c.status), expiresOn: text(c.expires_on) });
  }
  for (const p of list(sections, 'ssl_certificate_packs')) {
    const [managedBy, kind] = PACK_KIND[text(p.type)] ?? ['Cloudflare managed', `Certificate pack (${text(p.type) || 'unknown type'})`];
    const ca = CA_NAME[text(p.certificate_authority)] ?? text(p.certificate_authority);
    const certs = (Array.isArray(p.certificates) ? p.certificates : []).filter(isObj);
    if (!certs.length) {
      add({ source: 'Edge certificates', id: text(p.id), hosts: hostsOf(p.hosts), managedBy, kind, issuer: ca, status: text(p.status), expiresOn: '' });
      continue;
    }
    for (const c of certs) {
      add({ source: 'Edge certificates', id: text(c.id), hosts: hostsOf(c.hosts ?? p.hosts), managedBy, kind: `${kind}${c.signature ? ` · ${text(c.signature)}` : ''}`,
        issuer: text(c.issuer) || ca, status: text(c.status || p.status), expiresOn: text(c.expires_on) });
    }
  }
  for (const h of list(sections, 'custom_hostnames')) {
    const ssl = isObj(h.ssl) ? h.ssl : {};
    const custom = !!(ssl.custom_certificate || ssl.custom_csr_id);
    add({ source: 'Custom hostnames', id: text(ssl.id) || text(h.id), hosts: text(h.hostname), managedBy: custom ? 'Custom' : 'Cloudflare managed',
      kind: custom ? 'Custom hostname certificate (uploaded)' : `Custom hostname certificate (${text(ssl.type) || 'dv'}${ssl.method ? `, ${text(ssl.method)} validation` : ''})`,
      issuer: text(ssl.issuer) || CA_NAME[text(ssl.certificate_authority)] || text(ssl.certificate_authority), status: text(ssl.status || h.status), expiresOn: text(ssl.expires_on) });
  }
  for (const c of list(sections, 'origin_tls_client_auth')) {
    add({ source: 'Authenticated Origin Pulls', id: text(c.id), hosts: 'Zone-wide', managedBy: 'Custom', kind: 'Origin pull client certificate (uploaded)',
      issuer: text(c.issuer), status: text(c.status), expiresOn: text(c.expires_on) });
  }
  for (const c of list(sections, 'origin_tls_client_auth_hostnames_certificates')) {
    add({ source: 'Per-hostname Authenticated Origin Pulls', id: text(c.id), hosts: '', managedBy: 'Custom', kind: 'Per-hostname origin pull certificate (uploaded)',
      issuer: text(c.issuer), status: text(c.status), expiresOn: text(c.expires_on) });
  }
  for (const c of list(sections, 'client_certificates')) {
    const ca = isObj(c.certificate_authority) ? text(c.certificate_authority.name) : '';
    const byCloudflare = !ca || /cloudflare/i.test(ca);
    add({ source: 'Client certificates (mTLS)', id: text(c.id), hosts: text(c.common_name), managedBy: byCloudflare ? 'Cloudflare managed' : 'Custom',
      kind: byCloudflare ? 'mTLS client certificate (Cloudflare managed CA)' : 'mTLS client certificate (your CA)',
      issuer: ca || 'Cloudflare Managed CA', status: text(c.status), expiresOn: text(c.expires_on) });
  }
  for (const c of list(sections, 'acm_custom_trust_store')) {
    add({ source: 'Custom origin trust store', id: text(c.id), hosts: '', managedBy: 'Custom', kind: 'Origin CA certificate (uploaded)',
      issuer: text(c.issuer), status: text(c.status), expiresOn: text(c.expires_on) });
  }
  const at = (r: CertRow) => (r.expiresOn && !Number.isNaN(Date.parse(r.expiresOn)) ? Date.parse(r.expiresOn) : Infinity);
  return rows.sort((a, b) => at(a) - at(b));
}

/** Whole days until a certificate expires (negative: days since it expired); null when unknown. */
export function daysLeft(expiresOn: string, now = Date.now()): number | null {
  const t = Date.parse(expiresOn);
  return expiresOn && !Number.isNaN(t) ? Math.trunc((t - now) / 86_400_000) || 0 : null;
}

/** Whether a certificate has expired. */
export const isExpired = (expiresOn: string, now = Date.now()) => !!expiresOn && Date.parse(expiresOn) < now;

export const CERT_COLUMNS = ['hosts', 'managed_by', 'type', 'issuer', 'status', 'expires_on', 'days_left', 'listed_in', 'id'];
export const certRows = (certs: CertRow[], now = Date.now()): unknown[][] =>
  certs.map((c) => [c.hosts, c.managedBy, c.kind, c.issuer, c.status, c.expiresOn, daysLeft(c.expiresOn, now) ?? '', c.source, c.id]);

/** The DNS records as CSV rows. */
export const DNS_COLUMNS = ['type', 'name', 'content', 'proxied', 'ttl', 'priority', 'comment', 'id'];
export const dnsRows = (records: Record<string, unknown>[]): unknown[][] => [DNS_COLUMNS, ...records.map((r) => DNS_COLUMNS.map((c) => r[c]))];

// ── Which hosts a rule applies to ────────────────────────────────────────────

/** The hosts a rule is limited to. Both empty: it applies to the whole zone. */
export interface RuleScope {
  /** Exact hostnames (lowercase). */
  hosts: string[];
  /** Host conditions that are not one exact name (wildcards, contains, regexes, lists). */
  patterns: string[];
}

const ZONE_WIDE: RuleScope = { hosts: [], patterns: [] };
const normHost = (h: string) => h.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
const quoted = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
/** The host part of a URL or a Page Rules target (scheme optional, path and query dropped). */
const hostOfUrl = (u: string) => normHost(u.replace(/^[a-z*]+:\/\//i, '').split(/[/?#]/)[0]);
/** An exact hostname, or a pattern when it has wildcards (a bare * limits nothing). */
const hostOrPattern = (h: string): RuleScope | null => (!h || h === '*' ? null : /[*?]/.test(h) ? { hosts: [], patterns: [h] } : { hosts: [h], patterns: [] });
const merge = (xs: (RuleScope | null)[]): RuleScope => ({ hosts: [...new Set(xs.flatMap((x) => x?.hosts ?? []))], patterns: [...new Set(xs.flatMap((x) => x?.patterns ?? []))] });

/** Index of the bracket closing the one at `from` (quotes skipped), or -1. */
function closing(s: string, from: number): number {
  let depth = 0, quote = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === '"') quote = false; continue; }
    if (c === '"') quote = true;
    else if (c === '(' || c === '{' || c === '[') depth++;
    else if ((c === ')' || c === '}' || c === ']') && --depth === 0) return i;
  }
  return -1;
}

/** Splits an expression at a top-level operator (outside quotes and brackets). */
function splitTop(expr: string, op: RegExp): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === '(' || c === '{' || c === '[') {
      if (c === '"') { let j = i + 1; while (j < expr.length && expr[j] !== '"') j += expr[j] === '\\' ? 2 : 1; i = j; }
      else { const j = closing(expr, i); if (j < 0) return [expr]; i = j; }
      continue;
    }
    if (i > 0 && !/[\s)]/.test(expr[i - 1])) continue;
    const m = op.exec(expr.slice(i));
    if (m) { parts.push(expr.slice(from, i)); i += m[0].length - 1; from = i + 1; }
  }
  parts.push(expr.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Drops parentheses around the whole expression. */
function unwrap(e: string): string {
  let s = e.trim();
  while (s.startsWith('(') && closing(s, 0) === s.length - 1) s = s.slice(1, -1).trim();
  return s;
}

const HOST = String.raw`(?:lower\(\s*)?http\.host(?:\s*\))?`;
/** A quoted string (escaped quotes allowed); its text is the capture group. */
const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const URI = String.raw`(?:lower\(\s*)?http\.request\.full_uri(?:\s*\))?`;

/** One condition (no and/or): the hosts it limits a rule to, or null when it does not limit the host. */
function atomScope(a: string): RuleScope | null {
  let m: RegExpMatchArray | null;
  // A negated host condition (not http.host eq …, http.host ne …) excludes a host; the rule still runs everywhere else.
  if (/^(not\s|!)/.test(a)) return null;
  if ((m = a.match(new RegExp(`^${HOST}\\s+(?:eq|==)\\s+${STR}$`)))) return hostOrPattern(normHost(m[1]));
  if ((m = a.match(new RegExp(`^${HOST}\\s+in\\s+\\{([^}]*)\\}$`)))) return merge(quoted(m[1]).map((h) => hostOrPattern(normHost(h))));
  if ((m = a.match(new RegExp(`^${HOST}\\s+in\\s+(\\$[\\w-]+)$`)))) return { hosts: [], patterns: [`in list ${m[1]}`] };
  if ((m = a.match(new RegExp(`^${HOST}\\s+(?:strict\\s+)?wildcard\\s+${STR}$`)))) return hostOrPattern(normHost(m[1]));
  if ((m = a.match(new RegExp(`^${HOST}\\s+(contains|matches|~)\\s+${STR}$`)))) return { hosts: [], patterns: [`${m[1] === '~' ? 'matches' : m[1]} "${m[2]}"`] };
  if ((m = a.match(new RegExp(`^(starts_with|ends_with)\\(\\s*${HOST}\\s*,\\s*${STR}\\s*\\)$`)))) return { hosts: [], patterns: [`${m[1] === 'starts_with' ? 'starts with' : 'ends with'} "${m[2]}"`] };
  if ((m = a.match(new RegExp(`^${URI}\\s+(?:eq|==|(?:strict\\s+)?wildcard)\\s+${STR}$`)))) return hostOrPattern(hostOfUrl(m[1]));
  if ((m = a.match(new RegExp(`^${URI}\\s+in\\s+\\{([^}]*)\\}$`)))) return merge(quoted(m[1]).map((u) => hostOrPattern(hostOfUrl(u))));
  return null;
}

function exprScope(expr: string): RuleScope | null {
  const e = unwrap(expr);
  const ors = splitTop(e, /^(?:or|xor|\|\||\^\^)(?=[\s(])/);
  if (ors.length > 1) {
    // Limited only when every alternative is limited to some host.
    const each = ors.map(exprScope);
    return each.every(Boolean) ? merge(each) : null;
  }
  const ands = splitTop(e, /^(?:and|&&)(?=[\s(])/);
  if (ands.length > 1) {
    // One host condition limits the whole conjunction; exact names are the most specific.
    const each = ands.map(exprScope).filter((x): x is RuleScope => !!x);
    return each.find((x) => x.hosts.length) ?? each[0] ?? null;
  }
  return atomScope(e);
}

/** The hosts a ruleset rule's expression limits it to (Rules language: http.host, http.request.full_uri). */
export function ruleScope(expression: unknown): RuleScope {
  const e = text(expression).replace(/\s+/g, ' ').trim();
  if (!e || e === 'true') return ZONE_WIDE;
  const s = exprScope(e);
  return s && (s.hosts.length || s.patterns.length) ? s : ZONE_WIDE;
}

const pageTarget = (r: Record<string, unknown>) => {
  const t = (Array.isArray(r.targets) ? r.targets : []).filter(isObj).find((x) => x.target === 'url');
  return t && isObj(t.constraint) ? text(t.constraint.value) : '';
};

/** The hosts a Page Rule's URL target names (lab.example.com/*, *.example.com/*; *example.com/* is the whole zone). */
export function pageRuleScope(rule: Record<string, unknown>, zoneName: string): RuleScope {
  const h = hostOfUrl(pageTarget(rule));
  if (!h || h === '*' || h === `*${normHost(zoneName)}`) return ZONE_WIDE;
  return hostOrPattern(h) ?? ZONE_WIDE;
}

/** One rule, with the rule page it is on and the hosts it applies to. */
export interface ScopedRule {
  page: string;
  phase: string;
  /** Its position on the rule page (1-based). */
  n: number;
  name: string;
  match: string;
  action: string;
  detail: string;
  enabled: boolean;
  scope: RuleScope;
}

export interface HostRules {
  zoneName: string;
  /** Rules with no host condition: every hostname of the zone. */
  zoneWide: ScopedRule[];
  /** Rules limited to the zone name itself (the apex). */
  apex: ScopedRule[];
  /** Rules limited to other hostnames, one entry per hostname. inDns: the zone has an A, AAAA or CNAME record with that name. */
  hosts: { host: string; inDns: boolean; proxied: boolean; rules: ScopedRule[] }[];
  /** Rules limited by a host pattern (wildcard, contains, regex, list), one entry per pattern. */
  patterns: { pattern: string; rules: ScopedRule[] }[];
  /** DNS hostnames no rule names: only the zone-wide rules (and matching patterns) apply to them. */
  otherDnsHosts: { host: string; proxied: boolean }[];
}

/** Every rule of the zone (rule pages and Page Rules), grouped by the hostnames it applies to. */
export function rulesByHost(zoneName: string, pages: { label: string; phase: string; status: string; rules: Record<string, unknown>[] }[],
  sections: { key: string; data?: unknown }[], names: Record<string, string>): HostRules {
  const zone = normHost(zoneName);
  const all: ScopedRule[] = [];
  for (const p of pages) {
    if (p.status !== 'ok') continue;
    p.rules.forEach((r, i) => all.push({ page: p.label, phase: p.phase, n: i + 1, name: text(r.description || r.ref || r.id), match: text(r.expression),
      action: text(r.action), detail: actionDetail(r, names), enabled: r.enabled !== false, scope: ruleScope(r.expression) }));
  }
  const pr = sections.find((s) => s.key === 'pagerules')?.data;
  (Array.isArray(pr) ? pr.filter(isObj) : []).forEach((r, i) => {
    const actions = (Array.isArray(r.actions) ? r.actions : []).filter(isObj);
    all.push({ page: 'Page Rules', phase: 'pagerules', n: i + 1, name: pageTarget(r) || text(r.id), match: pageTarget(r), action: actions.map((a) => text(a.id)).join(', '),
      detail: actions.map((a) => `${text(a.id)}${a.value !== undefined ? ` = ${text(a.value)}` : ''}`).join(' · '), enabled: r.status !== 'disabled', scope: pageRuleScope(r, zoneName) });
  });

  const dnsData = sections.find((s) => s.key === 'dns_records')?.data;
  const dns = new Map<string, boolean>();
  for (const d of (Array.isArray(dnsData) ? dnsData : []).filter(isObj)) {
    if (!['A', 'AAAA', 'CNAME'].includes(text(d.type))) continue;
    const n = normHost(text(d.name));
    dns.set(n, (dns.get(n) ?? false) || d.proxied === true);
  }

  const out: HostRules = { zoneName, zoneWide: [], apex: [], hosts: [], patterns: [], otherDnsHosts: [] };
  const byHost = new Map<string, ScopedRule[]>();
  const byPattern = new Map<string, ScopedRule[]>();
  for (const r of all) {
    if (!r.scope.hosts.length && !r.scope.patterns.length) { out.zoneWide.push(r); continue; }
    for (const h of r.scope.hosts) {
      if (h === zone) out.apex.push(r);
      else byHost.set(h, [...(byHost.get(h) ?? []), r]);
    }
    for (const p of r.scope.patterns) byPattern.set(p, [...(byPattern.get(p) ?? []), r]);
  }
  out.hosts = [...byHost].sort(([a], [b]) => a.localeCompare(b)).map(([host, rules]) => ({ host, inDns: dns.has(host), proxied: dns.get(host) ?? false, rules }));
  out.patterns = [...byPattern].sort(([a], [b]) => a.localeCompare(b)).map(([pattern, rules]) => ({ pattern, rules }));
  out.otherDnsHosts = [...dns].filter(([h]) => h !== zone && !byHost.has(h)).sort(([a], [b]) => a.localeCompare(b)).map(([host, proxied]) => ({ host, proxied }));
  return out;
}

/** "whole zone", or the hostnames and host patterns a rule is limited to. */
export const scopeText = (s: RuleScope) => (s.hosts.length || s.patterns.length ? [...s.hosts, ...s.patterns].join(', ') : 'whole zone');
