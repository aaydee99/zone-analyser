import 'server-only';
import type { Progress } from './bg-job';
import { cached } from './cache';
import { cfGet, cfReason, inParallel, ok, refused } from './cf-read';
import { HttpError } from './http';
import { FIELD, J, errorText, gql, isLimit, isPermission, tokenCache, zoneLimits, type Limits } from './investigate-gql';
import { rankZones, zonesOf } from './investigate-scope';
import { LEAKED_WINDOWS, type LeakedConfig, type LeakedReport, type LeakedRule, type LeakedTraffic, type LeakedZone } from './investigate-types';
import { credentialFields, isLeaked, leakedFindings } from './leaked-creds-score';
import { partsOf } from './waf-fp';
import type { ZoneListItem } from './zone-catalog';

// Leaked credentials, per zone (read-only):
//  - configuration (REST): whether detection is on (GET /leaked-credential-checks), its custom detection
//    locations (GET /leaked-credential-checks/detections, Enterprise), the custom and rate limiting rules
//    that use a cf.waf.credential_check.* field (the two phase entrypoints), and whether the managed
//    transform that adds the Exposed-Credential-Check header is on (GET /managed_headers);
//  - traffic (GraphQL httpRequestsAdaptiveGroups): requests by check result, then the leaked ones by status
//    code, security action, path, client and hour. Cloudflare does not document the dimension's name, so it
//    is taken from the plan's field list, else from the schema (introspection), and never guessed.
// Five REST reads and, per part of the window (the plan's maxDuration), one query for the results and one
// or two for the leaked requests. Each zone's result is kept 30 minutes.

const TTL = 30 * 60_000;
const MAX_PARTS = 7;
const PARALLEL_ZONES = 2;
export const LEAKED_PAGE = 5;
export const LEAKED_PAGE_MAX = 10;
const DIMENSIONS_TYPE = 'ZoneHttpRequestsAdaptiveGroupsDimensions';
const LEAK_FIELD = /leaked_?credential/i;

type G = { count?: number; dimensions?: Record<string, unknown> };
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

// ── Configuration ───────────────────────────────────────────────────────────

interface RawRule { id?: string; description?: string; enabled?: boolean; action?: string; expression?: string; ratelimit?: { requests_per_period?: number; period?: number } }

async function readConfig(token: string, zoneId: string, signal?: AbortSignal): Promise<LeakedConfig> {
  const base = `/zones/${encodeURIComponent(zoneId)}`;
  const [status, detections, custom, rate, headers] = await Promise.all([
    cfGet<{ enabled?: boolean }>(token, `${base}/leaked-credential-checks`, signal),
    cfGet<{ id?: string; username?: string; password?: string }[]>(token, `${base}/leaked-credential-checks/detections`, signal),
    cfGet<{ rules?: RawRule[] }>(token, `${base}/rulesets/phases/http_request_firewall_custom/entrypoint`, signal),
    cfGet<{ rules?: RawRule[] }>(token, `${base}/rulesets/phases/http_ratelimit/entrypoint`, signal),
    cfGet<{ managed_request_headers?: { id?: string; enabled?: boolean }[] }>(token, `${base}/managed_headers`, signal),
  ]);
  const why = (r: Parameters<typeof cfReason>[0], perm: string) => `${refused(r) ? `The token cannot read it — it needs "${perm}" (or the plan lacks it)` : 'Could not be read'}: ${cfReason(r)}`;
  const c: LeakedConfig = { enabled: null, detections: null, rules: [], header: null };
  if (ok(status)) c.enabled = status.body!.result?.enabled === true;
  else c.enabledNote = why(status, 'Zone › Zone WAF › Read');
  if (ok(detections)) c.detections = (Array.isArray(detections.body!.result) ? detections.body!.result : []).map((d) => ({ id: str(d.id), username: str(d.username), password: str(d.password) }));
  else c.detectionsNote = detections.status === 403 || detections.status === 404 ? 'Custom detection locations are an Enterprise feature (or the token cannot read them)' : why(detections, 'Zone › Zone WAF › Read');
  const notes: string[] = [];
  for (const [phase, r] of [['custom', custom], ['ratelimit', rate]] as const) {
    if (r.status === 404) continue;
    if (!ok(r)) { notes.push(`${phase === 'custom' ? 'Custom rules' : 'Rate limiting rules'}: ${why(r, 'Zone › Zone WAF › Read')}`); continue; }
    for (const x of r.body!.result?.rules ?? []) {
      const fields = credentialFields(x.expression ?? '');
      if (!fields.length) continue;
      const rule: LeakedRule = { phase, id: str(x.id), description: str(x.description), enabled: x.enabled !== false, action: str(x.action), expression: str(x.expression), fields };
      if (phase === 'ratelimit' && x.ratelimit?.requests_per_period) rule.rate = { requests: Number(x.ratelimit.requests_per_period), period: Number(x.ratelimit.period) || 0 };
      c.rules.push(rule);
    }
  }
  if (notes.length) c.rulesNote = notes.join(' · ');
  if (ok(headers)) c.header = (headers.body!.result?.managed_request_headers ?? []).some((h) => LEAK_FIELD.test(str(h.id)) && h.enabled === true);
  return c;
}

// ── Traffic ─────────────────────────────────────────────────────────────────

/** The dimension that holds the check result: from the plan's field list, else from the schema. '' when there is none. */
async function resultField(token: string, rq: Limits, progress: Progress): Promise<string> {
  const listed = (rq.availableFields ?? []).map((f) => f.split(/[./]/).at(-1)!).find((f) => LEAK_FIELD.test(f) && FIELD.test(f));
  if (listed) return listed;
  return cached<string>(`investigate:leaked:field`, (v) => (v ? 24 * 3600_000 : 10 * 60_000), async () => {
    const r = await gql<{ __type?: { fields?: { name?: string }[] } | null }>(token, `{ __type(name: ${J(DIMENSIONS_TYPE)}) { fields { name } } }`, {}, progress);
    return (r.data?.__type?.fields ?? []).map((f) => str(f.name)).find((f) => LEAK_FIELD.test(f) && FIELD.test(f)) ?? '';
  });
}

interface Spec { alias: string; dims: string[]; limit: number; optional?: boolean }

async function readTraffic(z: ZoneListItem, token: string, hours: number, progress: Progress): Promise<{ traffic: LeakedTraffic | null; note?: string; unavailable?: boolean }> {
  const limits = await zoneLimits(token, z.id, progress).catch((e) => { throw new HttpError(503, e instanceof Error ? e.message : String(e)); });
  const rq = limits.httpRequestsAdaptiveGroups;
  if (!rq.enabled) return { traffic: null, note: "Request analytics are not available on this zone's plan", unavailable: true };
  const F = await resultField(token, rq, progress);
  if (!F) return { traffic: null, note: "Cloudflare's request analytics offer no leaked-credential result for this zone (its plan's field list and the schema name none), so only the configuration is shown", unavailable: true };
  const parts = partsOf(hours, rq).slice(-MAX_PARTS);
  if (!parts.length) return { traffic: null, note: 'Nothing in the window this plan keeps', unavailable: true };
  progress.total += parts.length * 3;
  const range = (p: { since: string; until: string }) => `datetime_geq: ${J(p.since)}, datetime_lt: ${J(p.until)}`;
  const zoneQ = (body: string) => `{ viewer { zones(filter: { zoneTag: ${J(z.id)} }) { ${body} } } }`;
  const errors: string[] = [];

  // 1. Every request in the window by result (a handful of rows), which also names the leaked values.
  const results = new Map<string, number>();
  for (const p of parts) {
    const r = await gql<{ viewer?: { zones?: { results?: G[] }[] } }>(token, zoneQ(`results: httpRequestsAdaptiveGroups(limit: 100, filter: { ${range(p)} }) { count dimensions { ${F} } }`), {}, progress);
    progress.done++;
    if (r.errors.length) {
      if (isPermission(r.errors, r.status)) return { traffic: null, note: `The token cannot read this zone's request analytics — it needs "Zone › Analytics › Read" (${errorText(r.errors)})`, unavailable: true };
      if (isLimit(r.errors)) throw new HttpError(503, errorText(r.errors));
      errors.push(errorText(r.errors));
    }
    for (const g of r.data?.viewer?.zones?.[0]?.results ?? []) results.set(str(g.dimensions?.[F]), (results.get(str(g.dimensions?.[F])) ?? 0) + (g.count ?? 0));
  }
  if (!results.size && errors.length) return { traffic: null, note: `Request analytics could not be read: ${errors[0]}` };
  const leakedValues = [...results.keys()].filter(isLeaked);
  const t: LeakedTraffic = {
    field: F, since: parts[0].since, until: parts.at(-1)!.until,
    results: [...results].map(([result, count]) => ({ result, count })).sort((a, b) => b.count - a.count),
    leaked: leakedValues.reduce((s, v) => s + (results.get(v) ?? 0), 0),
    byStatus: [], byAction: [], paths: [], ips: [], hours: [],
  };
  if (!leakedValues.length) { progress.done += parts.length * 2; return { traffic: { ...t, byAction: null } }; }

  // 2. The leaked requests, broken down (packed into queries of at most the plan's field count).
  const specs: Spec[] = [
    { alias: 'status', dims: [F, 'edgeResponseStatus'], limit: 500 },
    { alias: 'action', dims: [F, 'securityAction'], limit: 200, optional: true },
    { alias: 'paths', dims: [F, 'clientRequestHTTPHost', 'clientRequestPath', 'clientRequestHTTPMethodName'], limit: 500 },
    { alias: 'ips', dims: ['clientIP', 'clientAsn', 'clientASNDescription', 'clientCountryName'], limit: 500 },
    { alias: 'hours', dims: ['datetimeHour', F], limit: 2000 },
  ];
  const max = Math.max(6, rq.maxNumberOfFields);
  const pack = (list: Spec[]) => {
    const out: Spec[][] = []; let cur: Spec[] = [], n = 0;
    for (const s of list) { const w = s.dims.length + 1; if (cur.length && n + w > max) { out.push(cur); cur = []; n = 0; } cur.push(s); n += w; }
    if (cur.length) out.push(cur);
    return out;
  };
  const filter = (p: { since: string; until: string }) => `{ ${range(p)}, ${F}_in: [${leakedValues.map(J).join(', ')}] }`;
  const merged = new Map<string, Map<string, { dims: Record<string, string>; count: number }>>(specs.map((s) => [s.alias, new Map()]));
  let noAction = false;
  for (const p of parts) {
    let queries = pack(noAction ? specs.filter((s) => !s.optional) : specs);
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const ask = (list: Spec[]) => gql<{ viewer?: { zones?: Record<string, G[]>[] } }>(token,
        zoneQ(list.map((s) => `${s.alias}: httpRequestsAdaptiveGroups(limit: ${Math.min(s.limit, rq.maxPageSize)}, filter: ${filter(p)}, orderBy: [count_DESC]) { count dimensions { ${s.dims.join(' ')} } }`).join(' ')), {}, progress);
      let r = await ask(q);
      if (r.errors.length && !isLimit(r.errors) && q.some((s) => s.optional)) {
        // The plan's analytics lack the security action: read the rest without it, from here on.
        noAction = true;
        r = await ask(q.filter((s) => !s.optional));
        queries = [...queries.slice(0, i + 1), ...queries.slice(i + 1).map((x) => x.filter((s) => !s.optional)).filter((x) => x.length)];
      }
      if (r.errors.length) { if (isLimit(r.errors)) throw new HttpError(503, errorText(r.errors)); errors.push(errorText(r.errors)); }
      const got = r.data?.viewer?.zones?.[0] ?? {};
      for (const s of q) {
        for (const g of got[s.alias] ?? []) {
          const dims = Object.fromEntries(Object.entries(g.dimensions ?? {}).map(([k, v]) => [k, str(v)]));
          const key = JSON.stringify(dims);
          const m = merged.get(s.alias)!;
          const row = m.get(key) ?? { dims, count: 0 };
          row.count += g.count ?? 0;
          m.set(key, row);
        }
      }
    }
    progress.done += 2;
  }
  const rows = (a: string) => [...merged.get(a)!.values()].sort((x, y) => y.count - x.count);
  t.byStatus = rows('status').map((r) => ({ result: r.dims[F], status: Number(r.dims.edgeResponseStatus) || 0, count: r.count }));
  t.byAction = noAction ? null : rows('action').map((r) => ({ result: r.dims[F], action: r.dims.securityAction || 'none', count: r.count }));
  t.paths = rows('paths').slice(0, 100).map((r) => ({ result: r.dims[F], host: r.dims.clientRequestHTTPHost, path: r.dims.clientRequestPath, method: r.dims.clientRequestHTTPMethodName, count: r.count }));
  t.ips = rows('ips').slice(0, 100).map((r) => ({ ip: r.dims.clientIP, asn: r.dims.clientAsn, asnName: r.dims.clientASNDescription, country: r.dims.clientCountryName, count: r.count }));
  t.hours = rows('hours').map((r) => ({ hour: r.dims.datetimeHour, result: r.dims[F], count: r.count })).sort((a, b) => a.hour.localeCompare(b.hour));
  if (errors.length) t.note = `Partly read: ${errors[0]}`;
  return { traffic: t };
}

// ── A zone, an account ──────────────────────────────────────────────────────

async function readZone(z: ZoneListItem, token: string, hours: number, progress: Progress): Promise<LeakedZone> {
  const base = { zoneId: z.id, zoneName: z.name, plan: z.plan };
  progress.total += 5;
  const config = await readConfig(token, z.id, progress.signal).finally(() => { progress.done += 5; });
  const tr = await readTraffic(z, token, hours, progress);
  const message = [tr.note, config.enabledNote && `Detection status: ${config.enabledNote}`, config.rulesNote].filter(Boolean).join(' · ') || undefined;
  const nothing = config.enabled === null && !tr.traffic;
  return { ...base, status: nothing ? (tr.unavailable ? 'unavailable' : 'error') : 'ok', ...(message ? { message } : {}), config, traffic: tr.traffic, findings: leakedFindings(config, tr.traffic) };
}

/** GET /api/investigate/leaked?zone=ID | account=ID [&hours=24|72|168][&offset=0&limit=5]. */
export async function leakedReport(o: { zoneId?: string; accountId?: string; hours?: number; offset?: number; limit?: number; fresh?: boolean; progress?: Progress }): Promise<LeakedReport> {
  const hours = o.hours ?? 24;
  if (!(LEAKED_WINDOWS as readonly number[]).includes(hours)) throw new HttpError(400, `Choose ${LEAKED_WINDOWS.join(', ')} hours`);
  if (!o.zoneId && !o.accountId) throw new HttpError(400, 'Choose a zone or an account');
  const progress = o.progress ?? { done: 0, total: 0 };
  const scope = await zonesOf({ zoneId: o.zoneId, accountId: o.zoneId ? undefined : o.accountId });
  const offset = Math.max(0, Math.floor(o.offset ?? 0));
  const limit = Math.min(LEAKED_PAGE_MAX, Math.max(1, Math.floor(o.limit ?? LEAKED_PAGE)));
  const ranked = scope.kind === 'zone' ? scope.zones : (await rankZones(scope.zones)).zones;
  const page = ranked.slice(offset, offset + limit);
  const token = tokenCache();
  const zones = await inParallel(page, PARALLEL_ZONES, async (z): Promise<LeakedZone> => {
    try {
      return await cached<LeakedZone>(`investigate:leaked:v1:${z.id}:${hours}`, (v) => (v.status === 'error' ? 60_000 : TTL), async () => {
        const t = await token(scope.list.credentialOf[z.id].id);
        if (!t) return { zoneId: z.id, zoneName: z.name, plan: z.plan, status: 'error', message: 'The stored credential could not be decrypted', config: null, traffic: null, findings: [] };
        return readZone(z, t, hours, progress);
      }, o.fresh);
    } catch (e) {
      progress.signal?.throwIfAborted();
      return { zoneId: z.id, zoneName: z.name, plan: z.plan, status: 'error', message: e instanceof Error ? e.message : String(e), config: null, traffic: null, findings: [] };
    }
  });
  const first = scope.zones[0];
  return {
    scope: scope.kind === 'zone' ? { kind: 'zone', id: first.id, name: first.name } : { kind: 'account', id: o.accountId!, name: scope.label },
    hours, offset, limit, totalZones: ranked.length, zones, generatedAt: new Date().toISOString(),
  };
}
