// Zone tags and owners: the shapes and checks shared by server and client — no Node imports.
// Console data only (supabase/migrations/0015_zone_meta.sql): never sent to Cloudflare.

export interface ZoneMeta {
  zoneId: string;
  zoneName: string;
  accountName: string;
  /** Sorted, lower case, no repeats: "team:payments", "env:prod", "tier:critical". */
  tags: string[];
  owner: string;
  contact: string;
  notes: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** What a list shows next to a zone. */
export interface ZoneMetaLite { tags: string[]; owner: string }

/** A zone filter, as pages and APIs take it: zones with every tag, of this owner, with this text in their tags or notes. */
export interface ZoneMetaFilter { tags?: string[]; owner?: string; q?: string }

export const MAX_TAGS = 30;
export const MAX_TAG = 64;
export const MAX_OWNER = 200;
export const MAX_CONTACT = 200;
export const MAX_NOTES = 2000;
export const ZONE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A tag: starts with a letter or digit, then letters, digits and : . _ / - (at most 64). */
export const TAG_RE = /^[a-z0-9][a-z0-9:._/-]{0,63}$/;

/** The tag as stored (trimmed, lower case, inner spaces as "-"), or null when it cannot be one. */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return TAG_RE.test(t) ? t : null;
}

/** Tags from a list or from text separated by commas, semicolons or spaces: valid ones sorted without repeats, and the rest. */
export function parseTags(input: string | readonly string[] | null | undefined): { tags: string[]; bad: string[] } {
  const parts = typeof input === 'string' ? input.split(/[,;\s]+/) : [...(input ?? [])];
  const ok = new Set<string>();
  const bad: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string' || !p.trim()) continue;
    const t = normalizeTag(p);
    if (t) ok.add(t); else bad.push(p.trim().slice(0, 80));
  }
  return { tags: [...ok].sort(), bad };
}

/** One line of text (owner, contact): no control characters, trimmed, at most `max`. */
export const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
/** Notes keep their line breaks. */
export const notesText = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NOTES) : '');

/** Text search for the database: LIKE wildcards and PostgREST separators become spaces. */
export const searchTerm = (v: unknown) => (typeof v === 'string' ? v.replace(/[%_*,()\\]/g, ' ').trim().slice(0, 100) : '');

// ── Filters in a URL ────────────────────────────────────────────────────────

/** ?tags=a,b&owner=x&mq=text — the same names on every page and API. */
export function filterFromParams(p: URLSearchParams): ZoneMetaFilter {
  return { tags: parseTags(p.get('tags') ?? '').tags.slice(0, 10), owner: oneLine(p.get('owner'), MAX_OWNER), q: searchTerm(p.get('mq')) };
}

export function filterToParams(f: ZoneMetaFilter, p = new URLSearchParams()): URLSearchParams {
  if (f.tags?.length) p.set('tags', f.tags.join(',')); else p.delete('tags');
  if (f.owner) p.set('owner', f.owner); else p.delete('owner');
  if (f.q) p.set('mq', f.q); else p.delete('mq');
  return p;
}

export const isFilterEmpty = (f: ZoneMetaFilter | null | undefined) => !f || (!f.tags?.length && !f.owner && !f.q);

// ── CSV (import and export) ─────────────────────────────────────────────────

export const CSV_HEADER = ['zone_id', 'zone_name', 'account', 'tags', 'owner', 'contact', 'notes'] as const;

/** Splits CSV text into rows (RFC 4180: quoted fields, "" inside quotes, CRLF or LF). A leading BOM is ignored. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** A cell written by csvCell() with a formula guard ("'=…") comes back as it was. */
const unguard = (s: string) => (/^'[=+@\t\r-]/.test(s) ? s.slice(1) : s);

export interface CsvMetaRow {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  zoneId: string;
  zoneName: string;
  /** Only the columns the file has are changed. */
  tags?: string[];
  owner?: string;
  contact?: string;
  notes?: string;
}

/**
 * Reads an import file. Columns by header name (any order, any case): zone_id or zone_name (one
 * is needed), and any of tags, owner, contact, notes. Tags in one cell, separated by ; , or spaces.
 */
export function readMetaCsv(text: string, maxRows = 20_000): { rows: CsvMetaRow[]; errors: string[] } {
  const all = parseCsv(text);
  const errors: string[] = [];
  if (!all.length) return { rows: [], errors: ['The file is empty'] };
  const head = all[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iId = col('zone_id', 'id'), iName = col('zone_name', 'zone', 'name'), iTags = col('tags', 'tag');
  const iOwner = col('owner'), iContact = col('contact'), iNotes = col('notes', 'note');
  if (iId < 0 && iName < 0) return { rows: [], errors: ['The first line must name the columns, with zone_id or zone_name among them'] };
  if (iTags < 0 && iOwner < 0 && iContact < 0 && iNotes < 0) return { rows: [], errors: ['Nothing to import: add a tags, owner, contact or notes column'] };
  if (all.length - 1 > maxRows) errors.push(`Only the first ${maxRows.toLocaleString()} rows are read`);
  const rows: CsvMetaRow[] = [];
  for (let n = 1; n < all.length && rows.length < maxRows; n++) {
    const r = all[n];
    const get = (i: number) => (i >= 0 ? unguard((r[i] ?? '').trim()) : '');
    const zoneId = get(iId), zoneName = get(iName).toLowerCase();
    if (!zoneId && !zoneName) { errors.push(`Line ${n + 1}: no zone id or name`); continue; }
    if (zoneId && !ZONE_ID.test(zoneId)) { errors.push(`Line ${n + 1}: “${zoneId.slice(0, 80)}” is not a zone id`); continue; }
    const row: CsvMetaRow = { line: n + 1, zoneId, zoneName };
    if (iTags >= 0) {
      const t = parseTags(get(iTags));
      if (t.bad.length) errors.push(`Line ${n + 1}: not a tag: ${t.bad.slice(0, 3).join(', ')}`);
      if (t.tags.length > MAX_TAGS) { errors.push(`Line ${n + 1}: more than ${MAX_TAGS} tags`); continue; }
      row.tags = t.tags;
    }
    if (iOwner >= 0) row.owner = oneLine(get(iOwner), MAX_OWNER);
    if (iContact >= 0) row.contact = oneLine(get(iContact), MAX_CONTACT);
    if (iNotes >= 0) row.notes = notesText(get(iNotes));
    rows.push(row);
  }
  return { rows, errors };
}
