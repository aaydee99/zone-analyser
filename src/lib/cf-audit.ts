import 'server-only';
import { cached, tag } from './cache';
import { HttpError } from './http';
import { credentialForRun, listCredentialOptions } from './vault';
import { tokenAccounts } from './providers';
import {
  CF_RANGES, CF_RETENTION_DAYS, type CfAccountResult, type CfAuditReport, type CfChange, type CfHistoryResult, type CfRange, type CfZoneEvent,
} from './cf-audit-report';
import { classify, diff, fields, redact, resourceKey, stateAfter, targetName, unwrap, type FieldChange } from './cf-classify';
import fs from 'node:fs';
import path from 'node:path';
import { isConfigChange, parseBlocks } from './restore-hcl';
import { getSettings } from './settings';
import { DEFAULT_OUTPUT_DIR } from './store';

// Reads Cloudflare's account audit logs (Audit Logs v2) with the stored API tokens:
//   GET /accounts/{id}/logs/audit                     — the changes
//   GET /accounts/{id}/logs/audit/product_categories  — Cloudflare's own category for each product
//   GET /accounts/{id}/logs/audit/{id}/history        — Resource History, for old values
//   GET /zones?account.id={id}                        — created_on / activated_on, for onboarded zones
// Tokens are decrypted only here, on the server. Audit logs need "Account Settings: Read";
// the zone list needs "Zone: Read". The report keeps only configuration changes (isConfigChange):
// views and other reads (backup runs, lookups), failed requests and cache purges are left out.
// Views, GETs and failures are filtered out by Cloudflare itself (CHANGES_ONLY), so the per-account
// limit counts changes: a backup run's thousands of reads would otherwise fill it within hours and
// every period would show only the last day.

export const CF_API = 'https://api.cloudflare.com/client/v4';
const PAGE = 1000;
/** Per account and per report, so one busy account cannot make the response huge. */
const MAX_PER_ACCOUNT = 5000;
const MAX_TOTAL = 10_000;
const DAY = 86_400_000;

export interface RawEntry {
  id?: string;
  account?: { id?: string; name?: string };
  action?: { description?: string; result?: string; time?: string; type?: string };
  actor?: { email?: string; type?: string; context?: string; token_name?: string; ip_address?: string };
  raw?: { method?: string; status_code?: number; uri?: string };
  resource?: { id?: string; product?: string; type?: string; request?: unknown; response?: unknown };
  zone?: { id?: string; name?: string };
}
export interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
  result_info?: { cursor?: string; count?: string | number; history_status?: string; total_pages?: number };
}

// ── Period ──────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Turns a range (or custom yyyy-mm-dd dates, inclusive, UTC) into [since, before). */
export function resolvePeriod(range: string | null, sinceIn: string | null, beforeIn: string | null, now = new Date()) {
  const r = (CF_RANGES.find((x) => x.value === range)?.value ?? 'week') as CfRange;
  let since: Date;
  let before: Date;
  if (r === 'custom') {
    if (!sinceIn || !beforeIn || !DATE_RE.test(sinceIn) || !DATE_RE.test(beforeIn)) throw new HttpError(400, 'Choose a start and end date');
    since = new Date(`${sinceIn}T00:00:00Z`);
    before = new Date(new Date(`${beforeIn}T00:00:00Z`).getTime() + DAY);
    if (Number.isNaN(since.getTime()) || Number.isNaN(before.getTime())) throw new HttpError(400, 'Choose a start and end date');
    if (since >= before) throw new HttpError(400, 'The start date must be on or before the end date');
    if (before > now) before = now;
  } else {
    before = now;
    since = new Date(now.getTime() - CF_RANGES.find((x) => x.value === r)!.days! * DAY);
  }
  const oldest = new Date(now.getTime() - CF_RETENTION_DAYS * DAY);
  if (since < oldest) {
    if (r === 'custom') throw new HttpError(400, 'Cloudflare keeps audit logs for 18 months — choose a later start date');
    since = oldest;
  }
  return { range: r, since, before };
}

// ── Cloudflare calls ────────────────────────────────────────────────────────

/** A readable reason for a failed Cloudflare call, without echoing anything we sent. */
function cfFailure(status: number, body: Envelope<unknown> | null, permission: string): string {
  const msg = body?.errors?.[0]?.message ?? '';
  if (status === 401 || status === 403 || /authentication|unauthori[sz]ed|permission/i.test(msg)) {
    return `The API token cannot do this: add the "${permission}" permission to it`;
  }
  if (status === 429) return 'Cloudflare rate limit reached — try again in a few minutes';
  return msg ? `Cloudflare: ${msg}` : `Cloudflare answered HTTP ${status}`;
}

async function cfGet<T>(token: string, path: string, permission: string): Promise<Envelope<T>> {
  let res: Response;
  try {
    res = await fetch(`${CF_API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  } catch (err) {
    console.error('[cf-audit] request failed:', err);
    throw new Error('Could not reach the Cloudflare API');
  }
  let body: Envelope<T> | null = null;
  try { body = (await res.json()) as Envelope<T>; } catch { /* non-JSON */ }
  if (!res.ok || !body?.success) throw new Error(cfFailure(res.status, body, permission));
  return body;
}

const AUDIT_PERM = 'Account Settings: Read';
const ZONE_PERM = 'Zone: Read';
const acct = (id: string) => `/accounts/${encodeURIComponent(id)}`;

/** Audit Logs v2 filters (official schema): no views, no reads, no failed requests. */
const CHANGES_ONLY: [string, string][] = [['action_type.not', 'view'], ['raw_method.not', 'GET'], ['raw_method.not', 'HEAD'], ['action_result.not', 'failure']];

async function fetchEntries(token: string, accountId: string, since: Date, before: Date, cap: number) {
  const out: RawEntry[] = [];
  let cursor = '';
  for (;;) {
    const q = new URLSearchParams([['since', since.toISOString()], ['before', before.toISOString()], ['limit', String(Math.min(PAGE, cap - out.length))], ['direction', 'desc'], ...CHANGES_ONLY]);
    if (cursor) q.set('cursor', cursor);
    const body = await cfGet<RawEntry[]>(token, `${acct(accountId)}/logs/audit?${q}`, AUDIT_PERM);
    const rows = body.result ?? [];
    out.push(...rows);
    cursor = body.result_info?.cursor ?? '';
    if (!cursor || !rows.length) return { entries: out, truncated: false };
    if (out.length >= cap) return { entries: out, truncated: true };
  }
}

// Cloudflare's product → category labels change rarely; keep them for six hours per account.
async function productCategories(token: string, accountId: string): Promise<Map<string, string>> {
  return new Map(await cached(`cf:categories:${accountId}`, 6 * 3600_000, async () => {
    const pairs: [string, string][] = [];
    try {
      const body = await cfGet<{ label?: string; value?: string; products?: { value?: string }[] }[]>(token, `${acct(accountId)}/logs/audit/product_categories`, AUDIT_PERM);
      for (const c of body.result ?? []) for (const p of c.products ?? []) if (p.value && c.label) pairs.push([p.value.toLowerCase(), c.label]);
    } catch (err) {
      console.error('[cf-audit] product categories unavailable:', err instanceof Error ? err.message : err);
    }
    return pairs;
  }));
}

interface ZoneRow { id: string; name: string; status?: string; type?: string; created_on?: string; activated_on?: string | null; plan?: { name?: string } }

/** The account's zones, kept for five minutes. */
function listAccountZones(token: string, accountId: string): Promise<ZoneRow[]> {
  return cached(`cf:account-zones:${accountId}:${tag(token)}`, 5 * 60_000, () => readAccountZones(token, accountId));
}

async function readAccountZones(token: string, accountId: string): Promise<ZoneRow[]> {
  const zones: ZoneRow[] = [];
  for (let page = 1; page <= 400; page++) {
    const body = await cfGet<ZoneRow[]>(token, `/zones?account.id=${encodeURIComponent(accountId)}&per_page=50&page=${page}`, ZONE_PERM);
    zones.push(...(body.result ?? []));
    if (!body.result?.length || page >= (body.result_info?.total_pages ?? 1)) break;
  }
  return zones;
}

// ── Turning entries into changes ────────────────────────────────────────────

const meta = (e: RawEntry, accountId: string) => ({
  accountId: e.account?.id || accountId,
  zoneId: e.zone?.id ?? '',
  product: e.resource?.product ?? '',
  resourceType: e.resource?.type ?? '',
  resourceId: e.resource?.id ?? '',
  uri: e.raw?.uri ?? '',
  method: (e.raw?.method ?? '').toUpperCase(),
});
export const actionOf = (e: RawEntry) => (e.action?.type ?? '').toLowerCase();
const after = (e: RawEntry) => {
  const s = stateAfter(actionOf(e), e.resource?.request, e.resource?.response);
  return s === undefined || s === null ? s : redact(s);
};
const requestFields = (e: RawEntry): FieldChange[] => {
  const req = unwrap(e.resource?.request);
  return req === undefined || req === null || req === '' ? [] : fields(redact(req), 'new');
};
const actorOf = (e: RawEntry) => e.actor?.email || (e.actor?.token_name ? `token “${e.actor.token_name}”` : e.actor?.type || '');

/** What changed, given the state before this entry (undefined when unknown). */
function changesFor(e: RawEntry, prev: unknown): { changes: FieldChange[]; oldSource: CfChange['oldSource'] } {
  const type = actionOf(e);
  const now = after(e);
  if (type === 'create') return { changes: fields(now, 'new'), oldSource: 'none' };
  if (type === 'delete') return prev === undefined ? { changes: [], oldSource: 'lookup' } : { changes: fields(prev, 'old'), oldSource: 'previous' };
  if (prev === undefined) {
    // Old values not in this report: show what the request set; Resource History can add the old side.
    const sent = requestFields(e);
    return { changes: sent.length ? sent : fields(now, 'new'), oldSource: 'lookup' };
  }
  const d = now === undefined ? [] : diff(prev, now);
  return { changes: d.length ? d : requestFields(e), oldSource: 'previous' };
}

function buildChanges(entries: RawEntry[], accountId: string, categories: Map<string, string>): CfChange[] {
  // Oldest first, so each entry sees the state the previous change to the same resource left.
  const asc = [...entries].sort((a, b) => ((a.action?.time ?? '') < (b.action?.time ?? '') ? -1 : 1));
  const last = new Map<string, unknown>();
  const out: CfChange[] = [];
  for (const e of asc) {
    const m = meta(e, accountId);
    const key = resourceKey(m);
    const prev = key ? last.get(key) : undefined;
    const state = after(e);
    const official = categories.get(m.product.toLowerCase()) ?? '';
    const { category, feature } = classify({
      method: m.method, uri: m.uri, product: m.product, resourceType: m.resourceType, actionType: actionOf(e),
      description: e.action?.description ?? '', officialCategory: official, state: state ?? unwrap(e.resource?.request),
    });
    const { changes, oldSource } = changesFor(e, prev);
    out.push({
      id: String(e.id ?? ''),
      time: e.action?.time ?? '',
      accountId: m.accountId,
      accountName: e.account?.name ?? '',
      zoneId: m.zoneId,
      zoneName: e.zone?.name ?? '',
      category,
      feature,
      officialCategory: official,
      product: m.product,
      resourceType: m.resourceType,
      resourceId: m.resourceId,
      target: targetName(state ?? prev ?? unwrap(e.resource?.request), m.resourceId || ''),
      actionType: actionOf(e),
      result: (e.action?.result ?? '').toLowerCase(),
      description: e.action?.description ?? '',
      changes,
      oldSource,
      actorEmail: e.actor?.email ?? '',
      actorType: e.actor?.type ?? '',
      actorContext: e.actor?.context ?? '',
      actorTokenName: e.actor?.token_name ?? '',
      actorIp: e.actor?.ip_address ?? '',
      method: m.method,
      uri: m.uri,
      status: typeof e.raw?.status_code === 'number' ? e.raw.status_code : null,
    });
    // Only a change that went through moves the resource to its new state.
    if (key && (e.action?.result ?? 'success').toLowerCase() !== 'failure') {
      if (actionOf(e) === 'delete') last.delete(key);
      else if (state !== undefined) last.set(key, state);
    }
  }
  return out.reverse();
}

/** Zones added or activated in [since, before) from the zone list, plus removals and actors from the audit log. */
function zoneEvents(zones: ZoneRow[] | null, changes: CfChange[], accountId: string, accountName: string, since: Date, before: Date): CfZoneEvent[] {
  const inWindow = (iso?: string | null) => !!iso && Date.parse(iso) >= since.getTime() && Date.parse(iso) < before.getTime();
  const onboarding = changes.filter((c) => c.category === 'onboarding' && c.result !== 'failure');
  const who = (zoneId: string, name: string, feature: string) => {
    const c = onboarding.find((x) => x.feature === feature && (x.zoneId === zoneId || x.target === name));
    return c ? (c.actorEmail || (c.actorTokenName ? `token “${c.actorTokenName}”` : c.actorType)) : '';
  };
  const out: CfZoneEvent[] = [];
  for (const z of zones ?? []) {
    const base = {
      accountId, accountName, zoneId: z.id, zoneName: z.name, status: z.status ?? '', type: z.type ?? '', plan: z.plan?.name ?? '',
      createdOn: z.created_on ?? '', activatedOn: z.activated_on ?? '',
    };
    if (inWindow(z.created_on)) out.push({ ...base, event: 'added', time: z.created_on!, actor: who(z.id, z.name, 'Zone added') });
    // Activation of a zone added earlier (or re-activation) is onboarding too.
    if (inWindow(z.activated_on) && z.activated_on !== z.created_on) out.push({ ...base, event: 'activated', time: z.activated_on!, actor: '' });
  }
  const listed = new Set((zones ?? []).map((z) => z.id));
  for (const c of onboarding) {
    if (c.feature === 'Zone added' && zones === null) {
      // No zone list (token lacks Zone: Read): the audit log still shows the addition.
      out.push({ accountId, accountName, zoneId: c.zoneId, zoneName: c.zoneName || c.target, event: 'added', time: c.time, status: '', type: '', plan: '', createdOn: c.time, activatedOn: '', actor: who(c.zoneId, c.target, 'Zone added') });
    }
    if (c.feature === 'Zone removed' && !listed.has(c.zoneId)) {
      out.push({ accountId, accountName, zoneId: c.zoneId, zoneName: c.zoneName || c.target, event: 'removed', time: c.time, status: '', type: '', plan: '', createdOn: '', activatedOn: '', actor: who(c.zoneId, c.zoneName || c.target, 'Zone removed') });
    }
  }
  return out.sort((a, b) => (a.time < b.time ? 1 : -1));
}

/**
 * Audit-log changes for one stored Cloudflare credential, or for every stored one
 * (credentialId "all"; credentials for the same account are read once).
 */
export async function cloudflareAudit(credentialId: string, period: { range: CfRange; since: Date; before: Date }): Promise<CfAuditReport> {
  const options = (await listCredentialOptions()).filter((o) => o.kind === 'cloudflare');
  const chosen = credentialId === 'all' ? options : options.filter((o) => o.id === credentialId);
  if (!chosen.length) throw new HttpError(credentialId === 'all' ? 409 : 404, credentialId === 'all' ? 'No Cloudflare credentials are stored yet' : 'Credential not found');

  const accounts: CfAccountResult[] = [];
  const changes: CfChange[] = [];
  const events: CfZoneEvent[] = [];
  const seen = new Set<string>();
  // Each credential's accounts: its account ID, or every account its token can access.
  const targets: { c: Awaited<ReturnType<typeof credentialForRun>>; o: (typeof chosen)[number]; accountId: string; accountName: string }[] = [];
  for (const o of chosen) {
    const c = await credentialForRun(o.id, 'cloudflare');
    try {
      for (const a of await tokenAccounts(c)) targets.push({ c, o, accountId: a.id, accountName: a.name });
    } catch (err) {
      accounts.push({ accountId: '', accountName: '', credentialName: o.name, count: 0, truncated: false, error: err instanceof Error ? err.message : 'Could not list the accounts of this token' });
    }
  }
  for (const { c, o, accountId, accountName: knownName } of targets) {
    if (seen.has(accountId)) continue;
    seen.add(accountId);
    const left = MAX_TOTAL - changes.length;
    if (left <= 0) {
      accounts.push({ accountId, accountName: '', credentialName: o.name, count: 0, truncated: true, error: 'Skipped — the report already holds the maximum number of changes' });
      continue;
    }
    const result: CfAccountResult = { accountId, accountName: knownName, credentialName: o.name, count: 0, truncated: false };
    accounts.push(result);
    let mine: CfChange[] = [];
    try {
      const token = c.fields.apiToken;
      const [{ entries, truncated }, categories] = await Promise.all([
        fetchEntries(token, accountId, period.since, period.before, Math.min(MAX_PER_ACCOUNT, left)),
        productCategories(token, accountId),
      ]);
      const all = buildChanges(entries, accountId, categories);
      mine = all.filter(isConfigChange);
      await fillDeletedValues(mine, token, accountId);
      Object.assign(result, { accountName: all.find((x) => x.accountName)?.accountName ?? knownName, count: mine.length, ignored: all.length - mine.length, truncated });
      changes.push(...mine);
    } catch (err) {
      result.error = err instanceof Error ? err.message : 'Could not read the audit log';
    }
    let zones: ZoneRow[] | null = null;
    try {
      zones = await listAccountZones(c.fields.apiToken, accountId);
    } catch (err) {
      result.zonesError = err instanceof Error ? err.message : 'Could not list zones';
    }
    if (!result.accountName) result.accountName = (zones?.[0] as { account?: { name?: string } } | undefined)?.account?.name ?? '';
    events.push(...zoneEvents(zones, mine, accountId, result.accountName, period.since, period.before));
  }
  changes.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  events.sort((a, b) => (a.time < b.time ? 1 : -1));
  return { range: period.range, since: period.since.toISOString(), before: period.before.toISOString(), accounts, changes, zoneEvents: events };
}

/** Every change in one account's audit log in [since, before), newest first, with field-level detail. */
export async function accountChanges(token: string, accountId: string, since: Date, before: Date): Promise<{ changes: CfChange[]; truncated: boolean }> {
  const [{ entries, truncated }, categories] = await Promise.all([
    fetchEntries(token, accountId, since, before, MAX_TOTAL),
    productCategories(token, accountId),
  ]);
  return { changes: buildChanges(entries, accountId, categories), truncated };
}

// ── Old values of deletes ─────────────────────────────────────────────────────

/** Deletes looked up per report (each costs one or two API calls). */
const MAX_DELETE_LOOKUPS = 40;

/**
 * A delete shows what was deleted: the previous change in the period has it already; otherwise
 * Cloudflare Resource History, and failing that the newest local backup that has the object.
 */
async function fillDeletedValues(changes: CfChange[], token: string, accountId: string) {
  const todo = changes.filter((c) => c.actionType === 'delete' && c.oldSource === 'lookup' && c.result !== 'failure').slice(0, MAX_DELETE_LOOKUPS);
  const backups = todo.length ? localBackups(path.resolve((await getSettings()).outputDir || DEFAULT_OUTPUT_DIR)) : [];
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(async (c) => {
      try {
        const h = await historyLookup(token, accountId, c.id, Date.parse(c.time));
        if (h.changes.length) {
          Object.assign(c, { changes: h.changes, oldSource: 'history', oldNote: `Cloudflare Resource History${h.previousTime ? ` — state after the change of ${h.previousTime}${h.previousActor ? ` by ${h.previousActor}` : ''}` : ''}` });
          return;
        }
      } catch { /* no history: try the backup */ }
      const found = fromBackup(backups, c);
      if (found) Object.assign(c, { changes: found.changes, oldSource: 'backup', oldNote: `Backup ${found.folder} (taken before the delete)` });
    }));
  }
}

/** Local backup folders, newest first: <output>/<Account>_<YYYYMMDD_HHMMSS>[_partial]/. */
function localBackups(root: string): { folder: string; dir: string; time: number }[] {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.map((n) => {
    const m = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_partial)?$/.exec(n);
    return m ? { folder: n, dir: path.join(root, n), time: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) } : null;
  }).filter((x): x is { folder: string; dir: string; time: number } => !!x).sort((a, b) => b.time - a.time);
}

/** The deleted object's attributes from the newest backup taken before the delete that has it. */
function fromBackup(backups: { folder: string; dir: string; time: number }[], c: CfChange): { folder: string; changes: FieldChange[] } | null {
  if (!c.resourceId || !c.zoneName) return null;
  const at = Date.parse(c.time);
  for (const b of backups) {
    if (b.time > at) continue;
    const zdir = path.join(b.dir, c.zoneName);
    let files: string[] = [];
    try { files = fs.readdirSync(zdir).filter((f) => f.endsWith('.tf')); } catch { continue; }
    for (const f of files) {
      const text = fs.readFileSync(path.join(zdir, f), 'utf8');
      if (!text.includes(c.resourceId)) continue;
      const block = parseBlocks(text, f).find((x) => x.labelId === c.resourceId);
      if (!block) continue;
      // Top-level `key = value` lines (strings, numbers, booleans); nested blocks as their HCL.
      const changes: FieldChange[] = [];
      for (const m of block.text.matchAll(/^ {2}([a-z_0-9]+)\s*=\s*(.+)$/gm)) {
        if (m[1] === 'zone_id' || m[1] === 'account_id') continue;
        const v = m[2].trim();
        if (v === '{' || v === '[{' || v === '[') continue;
        changes.push({ path: m[1], old: /secret|password|token|private_key|psk|credential/i.test(m[1]) ? '••••••••' : v.replace(/^"(.*)"$/, '$1') });
      }
      if (changes.length) return { folder: b.folder, changes };
    }
  }
  return null;
}

// ── Resource History (old values from before the report's period) ──────────

/** The stored credential for a Cloudflare account. */
export async function credentialForAccount(accountId: string) {
  for (const o of (await listCredentialOptions()).filter((x) => x.kind === 'cloudflare')) {
    const c = await credentialForRun(o.id, 'cloudflare');
    if (c.fields.accountId === accountId) return c;
    // No account ID: the credential covers every account its token can access.
    if (!c.fields.accountId && (await tokenAccounts(c).catch(() => [])).some((a) => a.id === accountId)) return c;
  }
  throw new HttpError(404, 'No stored credential for this account');
}

/**
 * Old values for one entry: Cloudflare's Resource History lists earlier entries for the
 * same resource; the newest one before this entry holds the state it replaced.
 */
export async function cloudflareHistory(accountId: string, entryId: string, actionTime: string): Promise<CfHistoryResult> {
  const t = Date.parse(actionTime);
  if (!/^[0-9a-f]{32}$/.test(accountId) || !/^[A-Za-z0-9-]{1,64}$/.test(entryId) || Number.isNaN(t)) throw new HttpError(400, 'Invalid audit entry');
  const c = await credentialForAccount(accountId);
  return historyLookup(c.fields.apiToken, accountId, entryId, t);
}

/**
 * Resource History for one entry: the entry itself, and the newest earlier successful change to the
 * same resource (which holds the state this entry replaced; a delete there means it did not exist).
 */
export function historyFor(token: string, accountId: string, entryId: string, t: number): Promise<{ source?: RawEntry; prev?: RawEntry; status: string }> {
  // The changes before an entry do not change afterwards: keep the lookup for ten minutes.
  return cached(`cf:history:${accountId}:${entryId}:${t}`, 10 * 60_000, () => readHistory(token, accountId, entryId, t));
}

async function readHistory(token: string, accountId: string, entryId: string, t: number): Promise<{ source?: RawEntry; prev?: RawEntry; status: string }> {
  const since = new Date(Math.max(t - CF_RETENTION_DAYS * DAY, Date.now() - CF_RETENTION_DAYS * DAY));
  const q = new URLSearchParams({ action_time: new Date(t).toISOString(), since: since.toISOString(), before: new Date(t + 1000).toISOString(), direction: 'desc', limit: '100' });
  let body: Envelope<RawEntry[]>;
  try {
    body = await cfGet<RawEntry[]>(token, `${acct(accountId)}/logs/audit/${encodeURIComponent(entryId)}/history?${q}`, AUDIT_PERM);
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : 'Could not read Resource History');
  }
  const rows = body.result ?? [];
  const source = rows.find((e) => e.id === entryId) ?? await entryAt(token, accountId, entryId, t);
  const prev = rows
    .filter((e) => e.id !== entryId && Date.parse(e.action?.time ?? '') < t && (e.action?.result ?? 'success').toLowerCase() !== 'failure')
    .sort((a, b) => ((a.action?.time ?? '') < (b.action?.time ?? '') ? 1 : -1))
    .find((e) => actionOf(e) === 'delete' || after(e) !== undefined);
  return { source, prev, status: body.result_info?.history_status ?? '' };
}

/** One entry, read from the log by its exact time (the history may not repeat the entry itself). */
export async function entryAt(token: string, accountId: string, entryId: string, t: number): Promise<RawEntry | undefined> {
  const near = new URLSearchParams({ since: new Date(t - 1000).toISOString(), before: new Date(t + 1000).toISOString(), limit: '1000', direction: 'desc' });
  return (await cfGet<RawEntry[]>(token, `${acct(accountId)}/logs/audit?${near}`, AUDIT_PERM)).result?.find((e) => e.id === entryId);
}

async function historyLookup(token: string, accountId: string, entryId: string, t: number): Promise<CfHistoryResult> {
  const { source, prev, status } = await historyFor(token, accountId, entryId, t);
  if (!source || !prev || actionOf(prev) === 'delete') {
    return { changes: [], previousTime: prev?.action?.time ?? null, previousActor: prev ? actorOf(prev) : '', historyStatus: status || 'unavailable' };
  }
  return {
    changes: changesFor(source, after(prev)).changes,
    previousTime: prev.action?.time ?? null,
    previousActor: actorOf(prev),
    historyStatus: status,
  };
}
