// BIND zone files: a small parser and a comparison with the zone's current records, for the
// onboarding page. Pure (no Node imports): unit-tested in tests/bind-zone.test.ts.
// Handles $ORIGIN, $TTL, "@", relative and blank owner names, TTL and class in either order,
// parentheses over several lines, quoted strings (with ";" inside), comments, and Cloudflare's
// "; cf_tags=cf-proxied:true" marks in its own exports. $INCLUDE and $GENERATE are reported, not followed.

import { compactNum } from './num';


export interface ZoneRecord { name: string; ttl: number | null; type: string; content: string; proxied: boolean | null; line: number }
export interface ParseResult { records: ZoneRecord[]; errors: { line: number; text: string }[]; origin: string }

export const MAX_ZONE_BYTES = 512 * 1024;
export const MAX_RECORDS = 10_000;

const TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SRV', 'CAA', 'PTR', 'SOA', 'DS', 'DNSKEY', 'HTTPS', 'SVCB', 'TLSA', 'SSHFP', 'NAPTR', 'LOC', 'CERT', 'URI', 'SMIMEA', 'OPENPGPKEY', 'SPF']);
const CLASSES = new Set(['IN', 'CH', 'HS']);
/** Types whose data names another host (compared case-insensitively, without the final dot). */
const NAME_DATA: Record<string, number> = { CNAME: 0, NS: 0, PTR: 0, MX: 1, SRV: 3 };

const fqdn = (n: string, origin: string) => {
  const s = n.trim();
  if (s === '@') return origin;
  if (s.endsWith('.')) return s.slice(0, -1).toLowerCase();
  return origin ? `${s}.${origin}`.toLowerCase() : s.toLowerCase();
};

const TTL_RE = /^(\d+)([smhdw]?)$/i;
function ttlValue(tok: string): number | null {
  // BIND also takes "1h30m".
  if (!/^(\d+[smhdw]?)+$/i.test(tok)) return null;
  let total = 0;
  for (const m of tok.matchAll(/(\d+)([smhdw]?)/gi)) total += Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 } as Record<string, number>)[m[2].toLowerCase()];
  return total;
}

/** Splits a line into tokens, keeping quoted strings whole; returns the tokens and the comment. */
function tokenize(line: string): { tokens: string[]; comment: string } {
  const tokens: string[] = [];
  let cur = '', inQ = false, comment = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { cur += c; if (c === '\\' && i + 1 < line.length) { cur += line[++i]; } else if (c === '"') inQ = false; continue; }
    if (c === '"') { inQ = true; cur += c; continue; }
    if (c === ';') { comment = line.slice(i + 1); break; }
    if (c === ' ' || c === '\t') { if (cur) { tokens.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return { tokens, comment };
}

/** Record data as compared: names fully qualified and lower case, spaces collapsed. */
function normalize(type: string, data: string[], origin: string): string {
  const i = NAME_DATA[type];
  const parts = [...data];
  if (i !== undefined && parts[i] !== undefined) parts[i] = parts[i] === '.' ? '.' : fqdn(parts[i], origin);
  if (type === 'AAAA') return parts.join(' ').toLowerCase();
  if (type === 'TXT' || type === 'SPF') return parts.join(' ');
  return parts.join(' ');
}

export function parseZone(text: string, defaultOrigin = ''): ParseResult {
  let origin = defaultOrigin.toLowerCase().replace(/\.$/, '');
  let defTtl: number | null = null;
  let last = origin;
  const records: ZoneRecord[] = [];
  const errors: ParseResult['errors'] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n++) {
    let raw = lines[n];
    const lineNo = n + 1;
    // Parentheses: join until they close.
    let { tokens, comment } = tokenize(raw);
    if (tokens.some((t) => t.includes('('))) {
      let depth = tokens.join(' ').split('(').length - tokens.join(' ').split(')').length;
      while (depth > 0 && n + 1 < lines.length) {
        n++;
        const more = tokenize(lines[n]);
        tokens = [...tokens, ...more.tokens];
        comment = comment || more.comment;
        depth += more.tokens.join(' ').split('(').length - more.tokens.join(' ').split(')').length;
      }
      tokens = tokens.flatMap((t) => t.replace(/[()]/g, ' ').split(' ')).filter(Boolean);
      raw = lines[n];
    }
    if (!tokens.length) continue;
    const startsBlank = /^[ \t]/.test(lines[lineNo - 1]);
    if (tokens[0].startsWith('$')) {
      const d = tokens[0].toUpperCase();
      if (d === '$ORIGIN' && tokens[1]) origin = fqdn(tokens[1].endsWith('.') ? tokens[1] : `${tokens[1]}.`, '');
      else if (d === '$TTL' && tokens[1] && ttlValue(tokens[1]) !== null) defTtl = ttlValue(tokens[1]);
      else errors.push({ line: lineNo, text: `${tokens[0]} is not followed (only $ORIGIN and $TTL are)` });
      continue;
    }
    let i = 0;
    let name = last;
    if (!startsBlank) { name = fqdn(tokens[0], origin); i = 1; }
    let ttl: number | null = null;
    // TTL and class, in either order.
    for (let k = 0; k < 2 && i < tokens.length; k++) {
      const t = tokens[i];
      if (CLASSES.has(t.toUpperCase())) { i++; continue; }
      if (TTL_RE.test(t) || /^(\d+[smhdw])+$/i.test(t)) { ttl = ttlValue(t); i++; continue; }
    }
    const type = (tokens[i] ?? '').toUpperCase();
    if (!TYPES.has(type)) { errors.push({ line: lineNo, text: `Not a record this parser knows: ${raw.trim().slice(0, 120)}` }); continue; }
    const data = tokens.slice(i + 1);
    if (!data.length) { errors.push({ line: lineNo, text: `${type} record without data` }); continue; }
    last = name;
    const tags = /cf_tags=([^\s;]+)/.exec(comment)?.[1] ?? '';
    const proxied = /cf-proxied:true/.test(tags) ? true : /cf-proxied:false/.test(tags) ? false : null;
    records.push({ name, ttl: ttl ?? defTtl, type, content: normalize(type, data, origin), proxied, line: lineNo });
    if (records.length >= MAX_RECORDS) { errors.push({ line: lineNo, text: `Only the first ${compactNum(MAX_RECORDS)} records are compared` }); break; }
  }
  return { records, errors, origin };
}

export type DiffKind = 'missing' | 'extra' | 'different' | 'ttl' | 'proxied' | 'breaks' | 'note';
export interface DiffRow { kind: DiffKind; name: string; type: string; file: string; current: string; note: string }
export interface ZoneDiff { rows: DiffRow[]; counts: Record<DiffKind, number>; compared: { file: number; current: number } }

/** Records not compared: the SOA, and the apex NS (Cloudflare serves its own). */
const skip = (r: ZoneRecord, zone: string) => r.type === 'SOA' || (r.type === 'NS' && r.name === zone);
const key = (r: { name: string; type: string }) => `${r.name}\n${r.type}`;
const MAX_ROWS = 2_000;

/**
 * What changes when the zone moves to Cloudflare as it is now: records in the file Cloudflare does not
 * have (`missing` — they stop resolving), records only Cloudflare has (`extra`), the same name and type
 * with other data (`different`), TTL and proxy differences, and records that will not work (`breaks`).
 */
export function compareZones(file: ZoneRecord[], current: ZoneRecord[], zone: string): ZoneDiff {
  const z = zone.toLowerCase().replace(/\.$/, '');
  const f = file.filter((r) => !skip(r, z)), c = current.filter((r) => !skip(r, z));
  const group = (list: ZoneRecord[]) => { const m = new Map<string, ZoneRecord[]>(); for (const r of list) m.set(key(r), [...(m.get(key(r)) ?? []), r]); return m; };
  const fg = group(f), cg = group(c);
  const rows: DiffRow[] = [];
  const counts: Record<DiffKind, number> = { missing: 0, extra: 0, different: 0, ttl: 0, proxied: 0, breaks: 0, note: 0 };
  const add = (r: DiffRow) => { counts[r.kind]++; if (rows.length < MAX_ROWS) rows.push(r); };
  for (const [k, list] of fg) {
    const [name, type] = k.split('\n');
    const cur = cg.get(k) ?? [];
    if (!cur.length) { for (const r of list) add({ kind: 'missing', name, type, file: r.content, current: '', note: 'Not on Cloudflare: stops resolving once the nameservers change' }); continue; }
    const curSet = new Set(cur.map((r) => r.content));
    const fileSet = new Set(list.map((r) => r.content));
    const only = list.filter((r) => !curSet.has(r.content));
    const onlyCur = cur.filter((r) => !fileSet.has(r.content));
    if (only.length || onlyCur.length) add({ kind: 'different', name, type, file: only.map((r) => r.content).join(' | ') || '(same)', current: onlyCur.map((r) => r.content).join(' | ') || '(same)', note: only.length && onlyCur.length ? 'Different data' : only.length ? 'Cloudflare has fewer values' : 'Cloudflare has more values' });
    for (const r of list) {
      const m = cur.find((x) => x.content === r.content);
      if (!m) continue;
      // Cloudflare's "automatic" TTL is 1 in its export.
      if (r.ttl !== null && m.ttl !== null && m.ttl !== 1 && r.ttl !== m.ttl) add({ kind: 'ttl', name, type, file: String(r.ttl), current: String(m.ttl), note: 'TTL differs' });
      if (r.proxied !== null && m.proxied !== null && r.proxied !== m.proxied) add({ kind: 'proxied', name, type, file: r.proxied ? 'proxied' : 'DNS only', current: m.proxied ? 'proxied' : 'DNS only', note: 'Proxy status differs' });
    }
  }
  for (const [k, list] of cg) {
    if (fg.has(k)) continue;
    const [name, type] = k.split('\n');
    for (const r of list) add({ kind: 'extra', name, type, file: '', current: r.content, note: 'Only on Cloudflare (added by the import scan, or by hand)' });
  }
  // What will not work, over the records the zone is meant to have (Cloudflare's, plus the file's it lacks).
  const have = new Set(c.map((r) => `${key(r)}
${r.content}`));
  const merged = [...c, ...f.filter((r) => !have.has(`${key(r)}
${r.content}`))];
  const cnames = new Set(merged.filter((r) => r.type === 'CNAME').map((r) => r.name));
  for (const r of merged) {
    const target = r.type === 'MX' ? r.content.split(' ')[1] : r.type === 'SRV' ? r.content.split(' ')[3] : r.type === 'NS' ? r.content : null;
    if (target && cnames.has(target)) add({ kind: 'breaks', name: r.name, type: r.type, file: r.content, current: '', note: `${r.type} points at ${target}, which is a CNAME: mail and resolvers may refuse it (RFC 2181 §10.3)` });
    if (r.type === 'CNAME' && merged.some((x) => x.name === r.name && x.type !== 'CNAME')) add({ kind: 'breaks', name: r.name, type: 'CNAME', file: r.content, current: '', note: 'A CNAME cannot sit next to other records on the same name: Cloudflare refuses it' });
    if (r.type === 'CNAME' && r.name === z) add({ kind: 'note', name: r.name, type: 'CNAME', file: r.content, current: '', note: 'CNAME at the zone apex: Cloudflare flattens it (served as A/AAAA)' });
    if (r.name !== z && !r.name.endsWith(`.${z}`)) add({ kind: 'breaks', name: r.name, type: r.type, file: r.content, current: '', note: `Outside ${z}: cannot be added to this zone` });
  }
  return { rows, counts, compared: { file: f.length, current: c.length } };
}
