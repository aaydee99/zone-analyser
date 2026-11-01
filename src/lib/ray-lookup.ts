import 'server-only';
import type { Progress } from './bg-job';
import { HttpError } from './http';
import { FIELD, J, ZONE_ID, errorText, fieldsFor, gql, isLimit, isPermission, tokenCache, zoneLimits } from './investigate-gql';
import { rankZones, zonesOf } from './investigate-scope';
import { parseRay, rayWindow } from './ray-parse';
import { RAY_WINDOWS, type Cell, type Fields, type RayResult, type RaySecurityEvent } from './investigate-types';
import { MANAGED_RULESETS } from './traffic-types';
import type { ZoneListItem } from './zone-catalog';
import { inParallel } from './cf-read';
import { rulesetNames } from './zone-explorer';
import { compactNum } from './num';

// Ray ID lookup: which zone a Ray ID belongs to, and what happened to that request — who sent it,
// what it asked for, what it got, and which security rule acted on it. From Cloudflare's GraphQL
// Analytics API: firewallEventsAdaptive (security events) and httpRequestsAdaptive (single
// requests), both filtered by rayName. A Ray ID does not say which zone it belongs to, and those
// datasets are per zone, so the lookup searches zones:
//  - with a zone or a host name, only that zone (one query per day of the window);
//  - with an account, or "every zone", up to 10 zones per query (Cloudflare's per-query zone limit),
//    busiest zones first (when their traffic is cached), newest day first, and it stops at the first hit.
// A lookup never sends more than its query cap (RAY_MAX_QUERIES, 60 by default — a quarter of one
// token's GraphQL budget): beyond it, it says how far it got instead of fanning out over every zone.
// (A batch Cloudflare refuses is split to find the zone it refuses; those splits are capped at as many again.)
// Then one more query (plus the zone's limits, kept for six hours) reads the request in full.

export { parseRay };

const ZONES_PER_QUERY = 10;
const PARALLEL = 3;
export const RAY_MAX_QUERIES = Math.min(200, Math.max(5, Number(process.env.RAY_MAX_QUERIES) || 60));

// Fields read for the request and its security events. The plan's field list (settings) says which
// it offers; the first group is what the traffic pages already read on every plan, the rest is
// shown when the plan has it (origin timing, bot score with Bot Management …).
const EVENT_BASE = ['datetime', 'action', 'source', 'ruleId', 'rulesetId', 'description', 'clientIP', 'clientCountryName', 'clientAsn', 'clientASNDescription',
  'clientRequestHTTPMethodName', 'clientRequestHTTPHost', 'clientRequestPath', 'clientRequestQuery', 'userAgent', 'edgeResponseStatus', 'rayName'];
const EVENT_EXTRA = ['clientRequestHTTPProtocol', 'edgeColoName', 'kind', 'matchIndex', 'ref'];
const EVENT_MIN = ['datetime', 'action', 'source', 'ruleId', 'description', 'clientIP', 'clientRequestPath'];
const REQUEST_BASE = ['datetime', 'clientIP', 'clientCountryName', 'clientASNDescription', 'clientRequestHTTPMethodName', 'clientRequestHTTPHost', 'clientRequestPath',
  'clientRequestQuery', 'clientRequestHTTPProtocol', 'edgeResponseStatus', 'cacheStatus', 'edgeResponseBytes', 'userAgent', 'rayName'];
const REQUEST_EXTRA = ['clientAsn', 'originResponseStatus', 'originResponseDurationMs', 'edgeTimeToFirstByteMs', 'botScore', 'botScoreSrcName', 'botManagementDecision',
  'securityAction', 'securitySource', 'edgeColoName', 'upperTierColoName', 'clientSSLProtocol', 'clientRefererHost', 'edgeResponseContentTypeName'];
const REQUEST_MIN = ['datetime', 'clientIP', 'clientRequestPath', 'edgeResponseStatus'];

export interface RayOptions {
  zoneId?: string; host?: string; accountId?: string; all?: boolean;
  /** Hours searched: back from now, or around `at`. */
  hours?: number;
  /** About when the request was made (ISO time): the window is centred on it. */
  at?: string;
  maxQueries?: number;
  progress?: Progress;
}

interface Batch { credentialId: string; zones: ZoneListItem[] }

/** Zones in rank order, cut into queries of at most 10 zones that one token reads. */
function batchesOf(zones: ZoneListItem[], credentialOf: Record<string, { id: string }>): Batch[] {
  const open = new Map<string, Batch>();
  const out: Batch[] = [];
  for (const z of zones) {
    const c = credentialOf[z.id]?.id;
    if (!c || !ZONE_ID.test(z.id)) continue;
    let b = open.get(c);
    if (!b) { b = { credentialId: c, zones: [] }; open.set(c, b); out.push(b); }
    b.zones.push(z);
    if (b.zones.length >= ZONES_PER_QUERY) open.delete(c);
  }
  return out;
}

type Rows = { datetime?: string }[];
interface SearchZone { zoneTag?: string; fw?: Rows; rq?: Rows }

function searchQuery(tags: string[], ray: string, s: { since: string; until: string }, requests: boolean) {
  const f = `filter: { rayName: ${J(ray)}, datetime_geq: ${J(s.since)}, datetime_lt: ${J(s.until)} }`;
  return `{ viewer { zones(filter: { zoneTag_in: [${tags.map(J).join(', ')}] }) { zoneTag fw: firewallEventsAdaptive(limit: 1, ${f}) { datetime }`
    + `${requests ? ` rq: httpRequestsAdaptive(limit: 1, ${f}) { datetime }` : ''} } } }`;
}

/**
 * GET /api/investigate/ray (and the Slack command): finds a Ray ID and what happened to the request.
 * Throws HttpError 400/404 for a bad Ray ID or scope; Cloudflare's refusals are in `failed` and `notes`.
 */
export async function lookupRay(input: string, opts: RayOptions = {}): Promise<RayResult> {
  const ray = parseRay(input);
  if (!ray) throw new HttpError(400, 'Not a Ray ID (16 hex characters, optionally with the data center, e.g. 8f3a1b2c4d5e6f70-AMS)');
  const hours = opts.hours ?? 24;
  if (!(RAY_WINDOWS as readonly number[]).includes(hours)) throw new HttpError(400, `Search ${RAY_WINDOWS.join(', ')} hours`);
  const progress = opts.progress ?? { done: 0, total: 0 };
  const scope = await zonesOf(opts);
  const { zones, ranking } = await rankZones(scope.zones);
  let w: ReturnType<typeof rayWindow>;
  try { w = rayWindow(hours, opts.at); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
  const maxQueries = Math.min(RAY_MAX_QUERIES, Math.max(1, opts.maxQueries ?? RAY_MAX_QUERIES));
  const batches = batchesOf(zones, scope.list.credentialOf);
  // Newest day first across all zones: most lookups are for a request of the last hours.
  const jobs = w.slices.flatMap((s) => batches.map((b) => ({ s, b })));
  const run = jobs.slice(0, maxQueries);
  const token = tokenCache();
  const failed = new Map<string, string>();
  const searched = new Set<string>();
  let queries = 0;
  let hit: { zone: ZoneListItem; at: string } | null = null;
  progress.total += run.length + 2;

  /** One batch and day; a failing batch is split until the failure is down to one zone. */
  const search = async (b: Batch, s: { since: string; until: string }, requests = true): Promise<void> => {
    if (hit) return;
    const t = await token(b.credentialId);
    if (!t) { for (const z of b.zones) failed.set(z.name, 'The stored credential could not be decrypted'); return; }
    queries++;
    const r = await gql<{ viewer?: { zones?: SearchZone[] } }>(t, searchQuery(b.zones.map((z) => z.id), ray, s, requests), {}, progress);
    const got = r.data?.viewer?.zones ?? [];
    for (const z of b.zones) {
      const a = got.find((x) => x.zoneTag?.toLowerCase() === z.id.toLowerCase());
      if (!a) continue;
      searched.add(z.id);
      const when = a.fw?.[0]?.datetime ?? a.rq?.[0]?.datetime;
      if (when && !hit) hit = { zone: z, at: when };
    }
    const missing = b.zones.filter((z) => !got.some((x) => x.zoneTag?.toLowerCase() === z.id.toLowerCase()));
    if (!r.errors.length || !missing.length || hit) return;
    const final = isLimit(r.errors) || (isPermission(r.errors, r.status) && b.zones.length === 1);
    if (missing.length > 1 && !final && queries < maxQueries * 2) {
      const half = Math.ceil(missing.length / 2);
      await search({ ...b, zones: missing.slice(0, half) }, s, requests);
      await search({ ...b, zones: missing.slice(half) }, s, requests);
      return;
    }
    // One zone left: its plan may not keep single requests — look in its security events alone.
    if (missing.length === 1 && requests && !isLimit(r.errors) && queries < maxQueries * 2) return search({ ...b, zones: missing }, s, false);
    const why = isPermission(r.errors, r.status) ? `The token cannot read this zone's analytics — it needs "Zone › Analytics › Read" (${errorText(r.errors)})` : errorText(r.errors);
    for (const z of missing) failed.set(z.name, why);
  };
  await inParallel(run, PARALLEL, async (j) => { try { await search(j.b, j.s); } finally { progress.done++; } });

  const base = {
    ray, request: null, events: [] as RaySecurityEvent[], notes: [] as string[], failed: [...failed].map(([zone, error]) => ({ zone, error })),
    search: { kind: scope.kind, zones: zones.length, searched: searched.size, queries, capped: run.length < jobs.length && !hit, maxQueries, since: w.since, until: w.until, ranking },
    generatedAt: new Date().toISOString(),
  };
  const found = hit as { zone: ZoneListItem; at: string } | null;
  if (!found) {
    progress.done += 2;
    if (run.length < jobs.length) base.notes.push(`Ran ${run.length} of the ${jobs.length} queries this scope and window need (the cap is ${maxQueries}): narrow it to a zone, a host name or an account, or give the time of the request.`);
    if (!batches.length) base.notes.push('No zone in this scope has a stored token that reads it');
    return { ...base, found: false };
  }
  const detail = await readRay(ray, found.zone, found.at, await token(scope.list.credentialOf[found.zone.id].id), progress);
  return {
    ...base, found: true, at: found.at, request: detail.request, events: detail.events, notes: [...base.notes, ...detail.notes],
    zone: { id: found.zone.id, name: found.zone.name, accountId: found.zone.accountId, accountName: found.zone.accountName, plan: found.zone.plan },
  };
}

/** The request and its security events in full, from the zone it was found in (a few minutes around it). */
async function readRay(ray: string, zone: ZoneListItem, at: string, token: string, progress: Progress): Promise<{ request: Fields | null; events: RaySecurityEvent[]; notes: string[] }> {
  const notes: string[] = [];
  const limits = await zoneLimits(token, zone.id, progress).catch(() => null).finally(() => { progress.done++; });
  const t = Date.parse(at);
  const f = `filter: { rayName: ${J(ray)}, datetime_geq: ${J(new Date(t - 120_000).toISOString())}, datetime_lt: ${J(new Date(t + 120_000).toISOString())} }`;
  const pick = (ds: 'firewallEventsAdaptive' | 'httpRequestsAdaptive', base: string[], extra: string[]) => {
    const l = limits?.[ds];
    if (l && !l.enabled) return null;
    const { use, missing } = l ? fieldsFor(l, [...base, ...extra], base) : { use: [...base, ...extra], missing: [] };
    if (missing.length) notes.push(`Not offered on this zone's plan (${ds === 'httpRequestsAdaptive' ? 'request' : 'security event'}): ${missing.join(', ')}`);
    return use.filter((x) => FIELD.test(x));
  };
  const ev = pick('firewallEventsAdaptive', EVENT_BASE, EVENT_EXTRA);
  const rq = pick('httpRequestsAdaptive', REQUEST_BASE, REQUEST_EXTRA);
  if (!rq) notes.push("This zone's plan does not keep single requests (httpRequestsAdaptive): only what security did is shown");
  type A = { viewer?: { zones?: { fw?: Fields[]; rq?: Fields[] }[] } };
  const ask = (e: string[] | null, r: string[] | null) => gql<A>(token, `{ viewer { zones(filter: { zoneTag: ${J(zone.id)} }) { `
    + `${e ? `fw: firewallEventsAdaptive(limit: 20, ${f}, orderBy: [datetime_ASC]) { ${e.join(' ')} } ` : ''}${r ? `rq: httpRequestsAdaptive(limit: 1, ${f}) { ${r.join(' ')} } ` : ''}} } }`, {}, progress);
  let a = await ask(ev, rq);
  // Fields this plan refuses: the proven fields, then the fewest.
  if (a.errors.length && !a.data?.viewer?.zones?.length && !isLimit(a.errors)) a = await ask(ev && EVENT_BASE.filter((x) => ev.includes(x)), rq && REQUEST_BASE.filter((x) => rq.includes(x)));
  if (a.errors.length && !a.data?.viewer?.zones?.length && !isLimit(a.errors)) a = await ask(ev && EVENT_MIN, rq && REQUEST_MIN);
  progress.done++;
  if (a.errors.length) notes.push(`Cloudflare: ${errorText(a.errors)}`);
  const z = a.data?.viewer?.zones?.[0];
  const names: Record<string, string> = { ...MANAGED_RULESETS, ...(await rulesetNames(zone.id).catch(() => ({}))) };
  const events = (z?.fw ?? []).map((e): RaySecurityEvent => {
    const rs = String(e.rulesetId ?? '');
    return { ...clean(e), datetime: String(e.datetime ?? ''), action: String(e.action ?? ''), source: String(e.source ?? ''), ruleId: String(e.ruleId ?? ''), rulesetId: rs, description: String(e.description ?? ''), ...(names[rs] ? { rulesetName: names[rs] } : {}) };
  });
  return { request: z?.rq?.[0] ? clean(z.rq[0]) : null, events, notes };
}

const clean = (o: Record<string, unknown>): Fields => Object.fromEntries(Object.entries(o).map(([k, v]): [string, Cell] => [k, v === undefined ? null : typeof v === 'object' && v !== null ? JSON.stringify(v) : (v as Cell)]));

/** One line per fact, for a chat message (the Slack command). */
export function rayText(r: RayResult): string {
  if (!r.found) return `Ray ${r.ray}: not found in ${r.search.searched} of ${compactNum(r.search.zones)} zones (${r.search.since.slice(0, 16)}–${r.search.until.slice(0, 16)} UTC)${r.search.capped ? ' — the search stopped at its query cap; give a zone, host or account' : ''}`;
  const q = r.request ?? {};
  const e = r.events.find((x) => x.action !== 'log') ?? r.events[0];
  return [
    `Ray ${r.ray} — ${r.zone?.name} (${r.zone?.accountName}) at ${r.at}`,
    `${q.clientRequestHTTPMethodName ?? e?.clientRequestHTTPMethodName ?? ''} ${q.clientRequestHTTPHost ?? e?.clientRequestHTTPHost ?? ''}${q.clientRequestPath ?? e?.clientRequestPath ?? ''}${q.clientRequestQuery ?? e?.clientRequestQuery ?? ''} → ${q.edgeResponseStatus ?? e?.edgeResponseStatus ?? '?'}`,
    `Client ${q.clientIP ?? e?.clientIP ?? '?'} (${q.clientCountryName ?? e?.clientCountryName ?? '?'}, ${q.clientASNDescription ?? e?.clientASNDescription ?? '?'})`,
    e ? `Security: ${e.action} by ${e.source}${e.description ? ` — ${e.description}` : ''}${e.ruleId ? ` (rule ${e.ruleId}${e.rulesetName ? ` in ${e.rulesetName}` : ''})` : ''}` : 'Security: no rule acted on it',
    q.cacheStatus ? `Cache: ${q.cacheStatus}` : '',
  ].filter(Boolean).join('\n');
}
