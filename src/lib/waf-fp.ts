import 'server-only';
import type { Progress } from './bg-job';
import { cached } from './cache';
import { inParallel } from './cf-read';
import { HttpError } from './http';
import { J, errorText, gql, isLimit, isPermission, tokenCache, zoneLimits, type Limits } from './investigate-gql';
import { rankZones, zonesOf } from './investigate-scope';
import { WAF_WINDOWS, type WafReport, type WafSuspect, type WafZoneResult } from './investigate-types';
import { MANAGED_RULESETS } from './traffic-types';
import { MIN_EVENTS, PASSIVE_ACTIONS, draftException, scoreRule, type RuleStats } from './waf-fp-score';
import type { ZoneListItem } from './zone-catalog';
import { rulesetNames } from './zone-explorer';

// WAF false-positive finder: for each zone, the security events of the chosen window
// (firewallEventsAdaptiveGroups, grouped by rule and by IP, network, path and user agent; log-only
// and allow events left out), and for each rule's main path how often the other requests to it
// answered 2xx/3xx (httpRequestsAdaptiveGroups). waf-fp-score.ts turns that into a score with its
// reasons and a draft exception, which the user copies into the dashboard: nothing is written.
// A zone costs one query per part of the window (the plan's maxDuration, usually 3 days) and one
// more per part for the paths, plus its limits (kept six hours); its result is kept 30 minutes.
// An account is read a page of zones at a time (busiest first when their traffic is cached).

const TTL = 30 * 60_000;
const MAX_PARTS = 7;
const PARALLEL_ZONES = 2;
export const WAF_PAGE = 5;
export const WAF_PAGE_MAX = 10;
const SUSPECTS_PER_ZONE = 25;
const PATHS_CHECKED = 10;

interface Spec { alias: string; dims: string[]; limit: number }
const SPECS: Spec[] = [
  { alias: 'rules', dims: ['ruleId', 'rulesetId', 'source', 'action', 'description'], limit: 500 },
  { alias: 'ips', dims: ['ruleId', 'clientIP'], limit: 5000 },
  { alias: 'asns', dims: ['ruleId', 'clientAsn', 'clientASNDescription'], limit: 2000 },
  { alias: 'paths', dims: ['ruleId', 'clientRequestHTTPHost', 'clientRequestPath'], limit: 2000 },
  { alias: 'uas', dims: ['ruleId', 'userAgent'], limit: 2000 },
];

/** Queries of at most `max` fields each (each dimension and the count is one). */
function pack(specs: Spec[], max: number): Spec[][] {
  const out: Spec[][] = [];
  let cur: Spec[] = [], n = 0;
  for (const s of specs) {
    const w = s.dims.length + 1;
    if (cur.length && n + w > max) { out.push(cur); cur = []; n = 0; }
    cur.push(s); n += w;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The window in parts of at most the plan's maxDuration, newest last, never older than the plan keeps. */
function partsOf(hours: number, l: Limits, now = Date.now()) {
  const end = now;
  const start = Math.max(end - hours * 3600_000, end - l.notOlderThan * 1000 + 60_000);
  const step = l.maxDuration * 1000;
  const parts: { since: string; until: string }[] = [];
  for (let t = Math.max(start, end - step * MAX_PARTS); t < end; t += step) parts.push({ since: new Date(t).toISOString(), until: new Date(Math.min(t + step, end)).toISOString() });
  return parts;
}

type G = { count?: number; dimensions?: Record<string, unknown> };
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** One zone: read, scored, drafted. */
async function readZone(z: ZoneListItem, token: string, hours: number, progress: Progress): Promise<WafZoneResult> {
  const base = { zoneId: z.id, zoneName: z.name, events: 0, suspects: [] as WafSuspect[] };
  const limits = await zoneLimits(token, z.id, progress).catch((e) => { throw new HttpError(503, e instanceof Error ? e.message : String(e)); });
  const fw = limits.firewallEventsAdaptiveGroups;
  if (!fw.enabled) return { ...base, status: 'unavailable', message: "Security events are not available on this zone's plan" };
  const parts = partsOf(hours, fw);
  if (!parts.length) return { ...base, status: 'unavailable', message: 'Nothing in the window this plan keeps' };
  const queries = pack(SPECS, Math.max(6, fw.maxNumberOfFields));
  progress.total += parts.length * (queries.length + 1);
  const notIn = `action_notin: [${PASSIVE_ACTIONS.map(J).join(', ')}]`;
  const merged = new Map<string, Map<string, { dims: Record<string, string>; count: number }>>(SPECS.map((s) => [s.alias, new Map()]));
  const errors: string[] = [];
  for (const part of parts) {
    for (const q of queries) {
      const text = `{ viewer { zones(filter: { zoneTag: ${J(z.id)} }) { ${q.map((s) => `${s.alias}: firewallEventsAdaptiveGroups(limit: ${Math.min(s.limit, fw.maxPageSize)}, `
        + `filter: { datetime_geq: ${J(part.since)}, datetime_lt: ${J(part.until)}, ${notIn} }, orderBy: [count_DESC]) { count dimensions { ${s.dims.join(' ')} } }`).join(' ')} } } }`;
      const r = await gql<{ viewer?: { zones?: Record<string, G[]>[] } }>(token, text, {}, progress);
      progress.done++;
      if (r.errors.length) {
        if (isPermission(r.errors, r.status)) return { ...base, status: 'unavailable', message: `The token cannot read this zone's security events — it needs "Zone › Analytics › Read" (${errorText(r.errors)})` };
        errors.push(errorText(r.errors));
        if (isLimit(r.errors)) return { ...base, status: 'error', message: errorText(r.errors) };
      }
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
  }
  const rows = (alias: string) => [...merged.get(alias)!.values()];
  if (!rows('rules').length) {
    progress.done += parts.length;
    return errors.length ? { ...base, status: 'error', message: errors[0] } : { ...base, status: 'no events', since: parts[0].since, until: parts.at(-1)!.until };
  }

  // Per rule. A rule ID is unique within its ruleset; old products have none, so the source is part of the key.
  const stats = new Map<string, RuleStats>();
  const keyOf = (ruleId: string) => ruleId || '(no rule)';
  for (const r of rows('rules')) {
    const k = keyOf(r.dims.ruleId);
    const s = stats.get(k) ?? { ruleId: r.dims.ruleId, rulesetId: r.dims.rulesetId, source: r.dims.source, description: r.dims.description, actions: {}, ips: [], asns: [], paths: [], uas: [] };
    s.actions[r.dims.action] = (s.actions[r.dims.action] ?? 0) + r.count;
    if (!s.description) s.description = r.dims.description;
    stats.set(k, s);
  }
  for (const r of rows('ips')) stats.get(keyOf(r.dims.ruleId))?.ips.push({ ip: r.dims.clientIP, count: r.count });
  for (const r of rows('asns')) stats.get(keyOf(r.dims.ruleId))?.asns.push({ asn: r.dims.clientAsn, name: r.dims.clientASNDescription, count: r.count });
  for (const r of rows('paths')) stats.get(keyOf(r.dims.ruleId))?.paths.push({ host: r.dims.clientRequestHTTPHost, path: r.dims.clientRequestPath, count: r.count });
  for (const r of rows('uas')) stats.get(keyOf(r.dims.ruleId))?.uas.push({ ua: r.dims.userAgent, count: r.count });

  const first = [...stats.values()].map((s) => ({ s, sc: scoreRule(s, null) })).filter((x) => x.sc.mitigated >= MIN_EVENTS)
    .sort((a, b) => b.sc.score - a.sc.score || b.sc.mitigated - a.sc.mitigated).slice(0, SUSPECTS_PER_ZONE);
  for (const x of first) x.s.paths.sort((a, b) => b.count - a.count);

  // How the main paths answer otherwise: 2xx/3xx out of the requests security did not stop.
  const checked = [...new Map(first.map((x) => x.s.paths[0]).filter(Boolean).map((p) => [`${p.host}${p.path}`, p])).values()].slice(0, PATHS_CHECKED);
  const statusOf = new Map<string, { ok: number; total: number }>();
  const rq = limits.httpRequestsAdaptiveGroups;
  if (checked.length && rq.enabled) {
    for (const part of partsOf(hours, rq).slice(-MAX_PARTS)) {
      const text = `{ viewer { zones(filter: { zoneTag: ${J(z.id)} }) { ${checked.map((p, i) => `p${i}: httpRequestsAdaptiveGroups(limit: 100, filter: { datetime_geq: ${J(part.since)}, datetime_lt: ${J(part.until)}, `
        + `clientRequestHTTPHost: ${J(p.host)}, clientRequestPath: ${J(p.path)} }) { count dimensions { edgeResponseStatus } }`).join(' ')} } } }`;
      const r = await gql<{ viewer?: { zones?: Record<string, G[]>[] } }>(token, text, {}, progress);
      const got = r.data?.viewer?.zones?.[0] ?? {};
      checked.forEach((p, i) => {
        const s = statusOf.get(`${p.host}${p.path}`) ?? { ok: 0, total: 0 };
        for (const g of got[`p${i}`] ?? []) {
          const code = Number(g.dimensions?.edgeResponseStatus) || 0;
          s.total += g.count ?? 0;
          if (code >= 200 && code < 400) s.ok += g.count ?? 0;
        }
        statusOf.set(`${p.host}${p.path}`, s);
      });
    }
  }
  progress.done += parts.length;
  // Each path's mitigations (all rules), taken out of its total: those requests were answered by security, not by the site.
  const stoppedOn = new Map<string, number>();
  for (const r of rows('paths')) stoppedOn.set(`${r.dims.clientRequestHTTPHost}${r.dims.clientRequestPath}`, (stoppedOn.get(`${r.dims.clientRequestHTTPHost}${r.dims.clientRequestPath}`) ?? 0) + r.count);

  const names: Record<string, string> = { ...MANAGED_RULESETS, ...(await rulesetNames(z.id).catch(() => ({}))) };
  const suspects = first.map(({ s }): WafSuspect => {
    const top = s.paths[0] ?? { host: '', path: '/', count: 0 };
    const st = statusOf.get(`${top.host}${top.path}`);
    const others = st ? st.total - (stoppedOn.get(`${top.host}${top.path}`) ?? 0) : 0;
    const okShare = st && others > 0 ? Math.min(1, st.ok / others) : null;
    const sc = scoreRule(s, okShare);
    const rulesetName = names[s.rulesetId];
    const common = { ruleId: s.ruleId, rulesetId: s.rulesetId, source: s.source, description: s.description, ...(rulesetName ? { rulesetName } : {}), host: top.host, path: top.path, pathShare: sc.pathShare };
    return {
      zoneId: z.id, zoneName: z.name, ...common,
      mitigated: sc.mitigated, challenged: sc.challenged, solved: sc.solved, blocked: sc.blocked,
      ips: s.ips.length, asns: s.asns.length, residentialShare: sc.residentialShare, browserShare: sc.browserShare, okShare,
      score: sc.score, signals: sc.signals, draft: draftException(common, s.paths.map((p) => p.path)),
    };
  }).sort((a, b) => b.score - a.score || b.mitigated - a.mitigated);
  const events = rows('rules').reduce((n, r) => n + r.count, 0);
  return { ...base, status: 'ok', events, suspects, since: parts[0].since, until: parts.at(-1)!.until, ...(errors.length ? { message: `Partly read: ${errors[0]}` } : {}) };
}

/**
 * GET /api/investigate/waf?zone=ID | account=ID [&hours=24|72|168][&offset=0&limit=5]: suspected false
 * positives in one zone, or in one page of an account's zones (at most 10 zones per page).
 */
export async function wafReport(o: { zoneId?: string; accountId?: string; hours?: number; offset?: number; limit?: number; fresh?: boolean; progress?: Progress }): Promise<WafReport> {
  const hours = o.hours ?? 24;
  if (!(WAF_WINDOWS as readonly number[]).includes(hours)) throw new HttpError(400, `Choose ${WAF_WINDOWS.join(', ')} hours`);
  if (!o.zoneId && !o.accountId) throw new HttpError(400, 'Choose a zone or an account');
  const progress = o.progress ?? { done: 0, total: 0 };
  const scope = await zonesOf({ zoneId: o.zoneId, accountId: o.zoneId ? undefined : o.accountId });
  const offset = Math.max(0, Math.floor(o.offset ?? 0));
  const limit = Math.min(WAF_PAGE_MAX, Math.max(1, Math.floor(o.limit ?? WAF_PAGE)));
  const ranked = scope.kind === 'zone' ? scope.zones : (await rankZones(scope.zones)).zones;
  const page = ranked.slice(offset, offset + limit);
  const token = tokenCache();
  const zones = await inParallel(page, PARALLEL_ZONES, async (z): Promise<WafZoneResult> => {
    try {
      return await cached<WafZoneResult>(`investigate:waf:${z.id}:${hours}`, (v) => (v.status === 'error' ? 60_000 : TTL), async () => {
        const t = await token(scope.list.credentialOf[z.id].id);
        if (!t) return { zoneId: z.id, zoneName: z.name, status: 'error', message: 'The stored credential could not be decrypted', events: 0, suspects: [] };
        return readZone(z, t, hours, progress);
      }, o.fresh);
    } catch (e) {
      progress.signal?.throwIfAborted();
      return { zoneId: z.id, zoneName: z.name, status: 'error', message: e instanceof Error ? e.message : String(e), events: 0, suspects: [] };
    }
  });
  const first = scope.zones[0];
  return {
    scope: scope.kind === 'zone' ? { kind: 'zone', id: first.id, name: first.name } : { kind: 'account', id: o.accountId!, name: scope.label },
    hours, offset, limit, totalZones: ranked.length, zones,
    suspects: zones.flatMap((z) => z.suspects).sort((a, b) => b.score - a.score || b.mitigated - a.mitigated),
    generatedAt: new Date().toISOString(),
  };
}
