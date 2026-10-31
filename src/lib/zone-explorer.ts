import 'server-only';
import { cached, cacheBackend } from './cache';
import { HttpError } from './http';
import { mask } from './cf-read';
import { credentialForRun, listCredentialOptions } from './vault';
import { READ_GROUPS, RULE_PHASES, SETTING_GROUP, SETTING_IDS, SETTING_LABEL, ZONE_ENDPOINTS, type SettingGroup, type ZoneEndpoint, type ZoneGroup, type ZoneGroupReport, type ZoneListItem, type ZoneReport, type ZoneRulePhase, type ZoneSection, type ZoneSummary } from './zone-catalog';

// Zone explorer: everything the stored Cloudflare tokens can read about a zone, for any role.
// Read-only by construction — the one function that talks to Cloudflare (get) only sends GET.
// Tokens are decrypted only here; secret-looking values are masked before anything leaves the server.

const CF_API = 'https://api.cloudflare.com/client/v4';
/** Items read per list endpoint. */
const MAX_ITEMS = 50_000;
const PARALLEL = 8;
const LIST_TTL = 10 * 60_000;
const REPORT_TTL = 10 * 60_000;

interface Envelope { success?: boolean; errors?: { code?: number; message?: string }[]; result?: unknown; result_info?: { page?: number; total_pages?: number; cursor?: string; count?: number; total_count?: number } }

/** GET only. Never throws: the caller gets the status and Cloudflare's envelope (or text). */
async function get(token: string, path: string): Promise<{ status: number; body: Envelope | null; text?: string }> {
  try {
    const res = await fetch(`${CF_API}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), cache: 'no-store' });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) as Envelope }; } catch { return { status: res.status, body: null, text }; }
  } catch {
    return { status: 0, body: null };
  }
}

const cfMessage = (r: { status: number; body: Envelope | null }) =>
  r.body?.errors?.map((x) => x.message).filter(Boolean).join('; ') || (r.status ? `HTTP ${r.status}` : 'Could not reach the Cloudflare API');

// ── Zones the tokens can read ───────────────────────────────────────────────

interface RawZone { id: string; name: string; status?: string; type?: string; paused?: boolean; plan?: { name?: string }; account?: { id?: string; name?: string }; name_servers?: string[]; created_on?: string; activated_on?: string | null }
/**
 * Cached without tokens: `credentialOf` names the stored credential that reads each zone (its token is
 * decrypted when needed); `readersOf` lists every stored credential that reads it (monitoring spreads
 * zones over their tokens).
 */
export interface ZoneList { zones: ZoneListItem[]; problems: { credential: string; error: string }[]; at: number; credentialOf: Record<string, { id: string; name: string }>; readersOf: Record<string, string[]> }

export function listZones(fresh = false): Promise<ZoneList> {
  return cached('path:/api/zone-explorer', LIST_TTL, readZoneList, fresh);
}

/** The zone list read now, without the shared cache (monitoring lists zones on its own schedule). */
export async function readZoneList(): Promise<ZoneList> {
  const zones = new Map<string, ZoneListItem>();
  const tokenOf = new Map<string, { token: string; id: string; name: string }>();
  const problems: ZoneList['problems'] = [];
  const seenTokens = new Set<string>();
  const readers = new Map<string, Set<string>>();
  const reads = (zoneId: string, credentialId: string) => { const r = readers.get(zoneId) ?? new Set<string>(); r.add(credentialId); readers.set(zoneId, r); };
  for (const o of (await listCredentialOptions()).filter((x) => x.kind === 'cloudflare')) {
    let token: string;
    try { token = (await credentialForRun(o.id, 'cloudflare')).fields.apiToken; } catch { problems.push({ credential: o.name, error: 'Could not be decrypted' }); continue; }
    if (!token) continue;
    if (seenTokens.has(token)) {
      // Same token as an earlier credential: it reads the same zones.
      for (const z of zones.values()) {
        if (tokenOf.get(z.id)?.token !== token) continue;
        if (!z.credentials.includes(o.name)) z.credentials.push(o.name);
        reads(z.id, o.id);
      }
      continue;
    }
    seenTokens.add(token);
    for (let page = 1; page <= 400; page++) {
      const r = await get(token, `/zones?per_page=50&page=${page}`);
      if (r.status !== 200 || !r.body?.success) {
        problems.push({ credential: o.name, error: r.status === 403 ? `This token cannot list zones — it needs "Zone: Read" (${cfMessage(r)})` : cfMessage(r) });
        break;
      }
      const rows = (r.body.result as RawZone[]) ?? [];
      for (const z of rows) {
        reads(z.id, o.id);
        const cur = zones.get(z.id);
        if (cur) { if (!cur.credentials.includes(o.name)) cur.credentials.push(o.name); continue; }
        zones.set(z.id, {
          id: z.id, name: z.name, status: z.status ?? '', type: z.type ?? '', plan: z.plan?.name ?? '', paused: !!z.paused,
          accountId: z.account?.id ?? '', accountName: z.account?.name ?? '', nameServers: z.name_servers ?? [],
          createdOn: z.created_on ?? '', activatedOn: z.activated_on ?? null, credentials: [o.name],
        });
        tokenOf.set(z.id, { token, id: o.id, name: o.name });
      }
      if (!rows.length || page >= (r.body.result_info?.total_pages ?? 1)) break;
    }
  }
  const list: ZoneList = {
    zones: [...zones.values()].sort((a, b) => a.accountName.localeCompare(b.accountName) || a.name.localeCompare(b.name)),
    problems, at: Date.now(), credentialOf: Object.fromEntries([...tokenOf].map(([zid, x]) => [zid, { id: x.id, name: x.name }])),
    readersOf: Object.fromEntries([...readers].map(([zid, ids]) => [zid, [...ids]])),
  };
  return list;
}

// ── One zone, in full ───────────────────────────────────────────────────────

/** Reads one endpoint, following pages (page numbers or a cursor) up to MAX_ITEMS. */
async function readSection(token: string, zoneId: string, ep: ZoneEndpoint): Promise<ZoneSection> {
  const base = `/zones/${zoneId}${ep.path}`;
  const out: ZoneSection = { key: ep.key, label: ep.label, group: ep.group, path: ep.path || '/', status: 'ok', http: null };
  let items: unknown[] | null = null;
  let page = 1;
  let cursor = '';
  for (;;) {
    const q = new URLSearchParams();
    if (ep.perPage) q.set('per_page', String(ep.perPage));
    if (page > 1) q.set('page', String(page));
    if (cursor) q.set('cursor', cursor);
    const r = await get(token, `${base}${q.size ? `?${q}` : ''}`);
    out.http = r.status;
    if (r.status < 200 || r.status >= 300 || r.body?.success === false || !r.body) {
      if (items?.length) { out.truncated = true; break; } // later page failed: keep what was read
      out.status = r.status >= 400 && r.status < 500 ? 'unavailable' : 'error';
      out.message = r.status === 403 || r.body?.errors?.some((x) => x.code === 10000 || x.code === 9109)
        ? `The token cannot read this (${cfMessage(r)})` : cfMessage(r);
      return out;
    }
    const result = r.body.result;
    if (!Array.isArray(result)) { out.data = result; break; }
    items = [...(items ?? []), ...result];
    const info = r.body.result_info ?? {};
    if (items.length >= MAX_ITEMS) { out.truncated = true; break; }
    if (info.cursor && result.length) { cursor = info.cursor; continue; }
    if (info.total_pages && page < info.total_pages && result.length) { page++; continue; }
    break;
  }
  if (items) { out.data = items; out.count = items.length; }
  const empty = out.data === null || out.data === undefined || (Array.isArray(out.data) && !out.data.length);
  if (empty) out.status = 'empty';
  out.data = mask(out.data);
  return out;
}

async function inParallel<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** The zone and the credential that reads it (from the zone list; no token needed). */
async function zoneOf(zoneId: string) {
  let list = await listZones();
  if (!list.credentialOf[zoneId]) list = await listZones(true);
  const hit = list.credentialOf[zoneId];
  const zone = list.zones.find((z) => z.id === zoneId);
  if (!hit || !zone) throw new HttpError(404, 'No stored token can read this zone');
  return { hit, zone };
}

export async function zoneToken(zoneId: string) {
  const { hit, zone } = await zoneOf(zoneId);
  let token: string;
  try { token = (await credentialForRun(hit.id, 'cloudflare')).fields.apiToken; } catch { throw new HttpError(404, 'The stored credential for this zone is gone — read the zone list again'); }
  return { token, credential: hit.name, zone };
}

/**
 * Zone settings, one GET /settings/{setting_id} each (the bulk /settings endpoint is deprecated),
 * for one dashboard area: SSL/TLS, Security, Speed, Cache, Network or general settings.
 */
async function readSettings(token: string, zoneId: string, g: SettingGroup): Promise<ZoneSection> {
  const mine = await inParallel(SETTING_IDS.filter((id) => SETTING_GROUP[id] === g), PARALLEL, async (id) => ({ id, r: await get(token, `/zones/${zoneId}/settings/${id}`) }));
  const ok = mine.filter((x) => x.r.status === 200 && x.r.body?.success);
  const not = mine.filter((x) => !(x.r.status === 200 && x.r.body?.success));
  const section: ZoneSection = {
    key: `settings:${g}`, label: SETTING_LABEL[g], group: g, path: '/settings/{setting_id}', http: ok.length ? 200 : mine[0]?.r.status ?? null,
    status: ok.length ? 'ok' : mine.every((x) => x.r.status >= 400 && x.r.status < 500) ? 'unavailable' : 'error',
    data: mask(ok.map((x) => x.r.body!.result)), count: ok.length,
  };
  // Settings a plan or token cannot read, named with Cloudflare's reason.
  if (not.length) section.message = `Not readable: ${not.map((x) => `${x.id} (${cfMessage(x.r)})`).join(', ')}`;
  return section;
}

/** One dashboard rule page: GET /rulesets/phases/{phase}/entrypoint. No entrypoint (404) means nothing is configured. */
async function readPhase(token: string, zoneId: string, p: (typeof RULE_PHASES)[number]): Promise<ZoneRulePhase> {
  const r = await get(token, `/zones/${zoneId}/rulesets/phases/${p.phase}/entrypoint`);
  const base = { phase: p.phase, label: p.label, area: p.area, http: r.status, rules: [] as Record<string, unknown>[] };
  if (r.status === 200 && r.body?.success) {
    const rs = r.body.result as { id?: string; version?: string; last_updated?: string; rules?: Record<string, unknown>[] };
    const rules = (mask(rs.rules ?? []) as Record<string, unknown>[]);
    return { ...base, status: rules.length ? 'ok' : 'empty', rulesetId: rs.id, version: rs.version, lastUpdated: rs.last_updated, rules };
  }
  if (r.status === 404) return { ...base, status: 'empty' };
  return { ...base, status: r.status >= 400 && r.status < 500 ? 'unavailable' : 'error', message: r.status === 403 ? `The token cannot read this (${cfMessage(r)})` : cfMessage(r) };
}

// ── Endpoints: each one is cached under its own URL path ────────────────────

const ZX = (zoneId: string) => `/api/zone-explorer/${encodeURIComponent(zoneId)}`;
const fromCache = <T extends { generatedAt: string }>(x: T, asked: number): T => (Date.parse(x.generatedAt) < asked ? { ...x, cachedIn: cacheBackend() } : x);

/** GET /api/zone-explorer/{id}: the zone and the URL of each section and download. No Cloudflare call. */
export async function zoneSummary(zoneId: string): Promise<ZoneSummary> {
  const { hit, zone } = await zoneOf(zoneId);
  const z = ZX(zoneId);
  return {
    zone, credentialName: hit.name,
    sections: READ_GROUPS.map((g) => ({ key: g.key, label: g.label, href: `${z}/sections/${g.key}` })),
    downloads: { json: `${z}/export.json`, csv: `${z}/export.csv`, dnsCsv: `${z}/dns.csv`, bind: `${z}/dns-export`, report: `${z}/report`, certificates: `${z}/certificates`, hosts: `${z}/hosts` },
  };
}

export const isGroup = (g: string): g is ZoneGroup => READ_GROUPS.some((x) => x.key === g);

/** GET /api/zone-explorer/{id}/rulesets: names of the rulesets the zone can use (managed ones too). */
export function rulesetNames(zoneId: string, fresh = false): Promise<Record<string, string>> {
  return cached(`path:${ZX(zoneId)}/rulesets`, REPORT_TTL, async () => {
    const { token } = await zoneToken(zoneId);
    const s = await readSection(token, zoneId, ZONE_ENDPOINTS.find((e) => e.key === 'rulesets')!);
    return Object.fromEntries((Array.isArray(s.data) ? (s.data as { id?: string; name?: string }[]) : []).filter((x) => x.id).map((x) => [x.id!, x.name ?? '']));
  }, fresh);
}

/** GET /api/zone-explorer/{id}/sections/{group}: one section (its endpoints, settings and rule pages). */
export async function zoneGroup(zoneId: string, group: ZoneGroup, fresh = false): Promise<ZoneGroupReport> {
  const asked = Date.now();
  return fromCache(await cached(`path:${ZX(zoneId)}/sections/${group}`, REPORT_TTL, () => readGroup(zoneId, group, fresh), fresh), asked);
}

async function readGroup(zoneId: string, group: ZoneGroup, fresh: boolean): Promise<ZoneGroupReport> {
  const { token, credential, zone } = await zoneToken(zoneId);
  const g = READ_GROUPS.find((x) => x.key === group)!;
  const phases = RULE_PHASES.filter((p) => p.area === group);
  const [sections, settings, rules, names] = await Promise.all([
    inParallel(ZONE_ENDPOINTS.filter((e) => e.group === group), PARALLEL, (ep) => readSection(token, zoneId, ep)),
    SETTING_IDS.some((id) => SETTING_GROUP[id] === group) ? readSettings(token, zoneId, group as SettingGroup) : null,
    inParallel(phases, PARALLEL, (p) => readPhase(token, zoneId, p)),
    phases.length ? rulesetNames(zoneId, fresh) : {},
  ]);
  // Settings come first in a section — except Zone settings, which opens with the zone's details.
  if (settings) { if (group === 'zone') sections.push(settings); else sections.unshift(settings); }
  return { zoneId, zoneName: zone.name, group, label: g.label, generatedAt: new Date().toISOString(), credentialName: credential, sections, rules, rulesetNames: names };
}

/** GET /api/zone-explorer/{id}/report: every section in one report (each from its own cached endpoint). */
export async function zoneReport(zoneId: string, fresh = false): Promise<ZoneReport> {
  const { hit, zone } = await zoneOf(zoneId);
  const parts = await inParallel(READ_GROUPS, 4, (g) => zoneGroup(zoneId, g.key, fresh));
  return {
    zone, credentialName: hit.name,
    generatedAt: parts.map((p) => p.generatedAt).sort()[0] ?? new Date().toISOString(),
    ...(parts.length && parts.every((p) => p.cachedIn) ? { cachedIn: parts[0].cachedIn } : {}),
    sections: parts.flatMap((p) => p.sections),
    rules: parts.flatMap((p) => p.rules),
    rulesetNames: Object.assign({}, ...parts.map((p) => p.rulesetNames)),
  };
}

/** GET /api/zone-explorer/{id}/dns-export: the zone's DNS records as a BIND zone file (Cloudflare's own export). */
export function dnsExport(zoneId: string, fresh = false): Promise<{ name: string; text: string }> {
  return cached(`path:${ZX(zoneId)}/dns-export`, REPORT_TTL, async () => {
    const { token, zone } = await zoneToken(zoneId);
    const r = await get(token, `/zones/${zoneId}/dns_records/export`);
    if (r.status !== 200 || r.text === undefined) throw new HttpError(r.status === 403 ? 403 : 502, `Cloudflare: ${cfMessage(r)}`);
    return { name: zone.name, text: r.text };
  }, fresh);
}

