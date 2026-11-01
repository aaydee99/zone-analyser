import 'server-only';
import { compactNum } from './num';
import type { Progress } from './bg-job';
import { cached } from './cache';
import { cachedActivity } from './cf-audit-cache';
import { changeTitle } from './cf-audit-report';
import { pagesDeployments, workerVersions } from './cf-actions';
import { cfList } from './cf-read';
import { HttpError } from './http';
import { J, errorText, gql, isPermission, tokenCache, zoneLimits } from './investigate-gql';
import { zonesOf } from './investigate-scope';
import { TIMELINE_WINDOWS, type TimelineEvent, type TimelineReport, type TimelineSeries, type TimelineSource } from './investigate-types';
import { CHECK, type CheckId } from './monitor-types';
import { must } from './monitor-store';
import { db } from './supabase';
import { fillBuckets, findSpikes } from './timeline-spikes';
import { MITIGATING_ACTIONS } from './traffic-types';
import type { ZoneListItem } from './zone-catalog';

// Incident timeline for one zone: on one time axis, what changed and what happened.
//  - Config changes: the account's Cloudflare audit log, from the activity page's cache (cf-audit-cache).
//  - Traffic: requests, 4xx, 5xx and blocked / challenged events per 5 minutes (6 hours) or per
//    hour, from GraphQL (httpRequestsAdaptiveGroups, firewallEventsAdaptiveGroups); spikes are
//    marked by timeline-spikes.ts.
//  - Deployments: versions of the Workers routed on the zone and deployments of the Pages projects
//    serving its hosts (cf-actions' read functions — GET only).
//  - Stored monitoring data: certificate expiry (monitor_rows), open findings of the zone (drift,
//    certificates, health checks …) and alerts Cloudflare sent to the console (cloudflare_alerts).
// Each source is read on its own; one that fails is listed with its reason. Kept five minutes.

const TTL = 5 * 60_000;
const MAX_SCRIPTS = 5;
const MAX_PROJECTS = 5;
const MAX_PARTS = 4;

const iso = (t: number) => new Date(t).toISOString();
const within = (at: string | null | undefined, since: string, until: string) => !!at && at >= since && at <= until;

type G = { count?: number; dimensions?: Record<string, string> };

/** Requests, 4xx, 5xx and mitigated security events per bucket. */
async function readTraffic(z: ZoneListItem, token: string, since: string, until: string, bucketMs: number, progress: Progress): Promise<{ series: TimelineSeries[]; source: TimelineSource }> {
  const limits = await zoneLimits(token, z.id, progress);
  const rq = limits.httpRequestsAdaptiveGroups, fw = limits.firewallEventsAdaptiveGroups;
  const fine = bucketMs < 3_600_000;
  const dim = fine ? 'datetimeMinute' : 'datetimeHour';
  const start = Math.max(Date.parse(since), Date.now() - Math.min(rq.notOlderThan, fw.notOlderThan) * 1000 + 60_000);
  const step = Math.min(rq.maxDuration, fw.maxDuration) * 1000;
  const end = Date.parse(until);
  const parts: { since: string; until: string }[] = [];
  for (let t = Math.max(start, end - step * MAX_PARTS); t < end; t += step) parts.push({ since: iso(t), until: iso(Math.min(t + step, end)) });
  const raw: Record<TimelineSeries['key'], { t: string; v: number }[]> = { requests: [], '4xx': [], '5xx': [], blocked: [] };
  const errors: string[] = [];
  const limit = (ms: number) => Math.min(rq.maxPageSize, fw.maxPageSize, Math.ceil(ms / (fine ? 60_000 : 3_600_000)) + 5);
  for (const p of parts) {
    const n = limit(Date.parse(p.until) - Date.parse(p.since));
    const w = `datetime_geq: ${J(p.since)}, datetime_lt: ${J(p.until)}`;
    const ask = (alias: string, ds: string, extra: string) => `${alias}: ${ds}(limit: ${n}, filter: { ${w}${extra} }, orderBy: [${dim}_ASC]) { count dimensions { ${dim} } }`;
    const text = `{ viewer { zones(filter: { zoneTag: ${J(z.id)} }) { `
      + `${rq.enabled ? `${ask('requests', 'httpRequestsAdaptiveGroups', '')} ${ask('e4', 'httpRequestsAdaptiveGroups', ', edgeResponseStatus_geq: 400, edgeResponseStatus_lt: 500')} ${ask('e5', 'httpRequestsAdaptiveGroups', ', edgeResponseStatus_geq: 500')} ` : ''}`
      + `${fw.enabled ? ask('blocked', 'firewallEventsAdaptiveGroups', `, action_in: [${MITIGATING_ACTIONS.map(J).join(', ')}]`) : ''} } } }`;
    progress.total++;
    const r = await gql<{ viewer?: { zones?: Record<string, G[]>[] } }>(token, text, {}, progress);
    progress.done++;
    if (r.errors.length) errors.push(isPermission(r.errors, r.status) ? `The token cannot read this zone's analytics — it needs "Zone › Analytics › Read" (${errorText(r.errors)})` : errorText(r.errors));
    const got = r.data?.viewer?.zones?.[0] ?? {};
    const put = (key: TimelineSeries['key'], alias: string) => { for (const g of got[alias] ?? []) raw[key].push({ t: g.dimensions?.[dim] ?? '', v: g.count ?? 0 }); };
    put('requests', 'requests'); put('4xx', 'e4'); put('5xx', 'e5'); put('blocked', 'blocked');
  }
  const label: Record<TimelineSeries['key'], string> = { requests: 'Requests', '4xx': '4xx responses', '5xx': '5xx responses', blocked: 'Blocked or challenged' };
  const series = (['requests', '5xx', '4xx', 'blocked'] as const).map((key) => ({ key, label: label[key], points: fillBuckets(raw[key], since, until, bucketMs) }));
  const count = series.reduce((n, s) => n + s.points.reduce((m, p) => m + p.v, 0), 0);
  const ok = parts.length && errors.length < parts.length;
  return {
    series: ok ? series : [],
    source: { key: 'traffic', label: 'Traffic (GraphQL Analytics)', status: ok ? 'ok' : errors.length ? 'error' : 'unavailable', count, ...(errors.length ? { message: errors[0] } : !parts.length ? { message: 'Nothing in the window this plan keeps' } : {}) },
  };
}

/** Spikes of 5xx, 4xx and blocked as events; 5xx and 4xx only count when they are also a real share of requests. */
function spikeEvents(series: TimelineSeries[], bucketMs: number): TimelineEvent[] {
  const total = series.find((s) => s.key === 'requests')?.points ?? [];
  const at = new Map(total.map((p) => [p.t, p.v]));
  const out: TimelineEvent[] = [];
  const mins = bucketMs / 60_000;
  for (const s of series.filter((x) => x.key !== 'requests')) {
    for (const sp of findSpikes(s.points, s.key === 'blocked' ? 50 : 20)) {
      const req = at.get(sp.peakAt) ?? 0;
      const share = req ? sp.peak / req : null;
      if (s.key !== 'blocked' && share !== null && share < 0.02) continue;
      out.push({
        at: sp.start, kind: 'spike', tone: s.key === '5xx' ? 'bad' : 'warn',
        title: `${s.label} spike: ${compactNum(sp.peak)} per ${mins} min at its peak`,
        detail: `Typical ${compactNum(Math.round(sp.typical))} per ${mins} min in this window; flagged above ${compactNum(Math.round(sp.threshold))} (3× the median and 6 robust deviations above it). `
          + `${sp.start === sp.end ? 'One bucket' : `From ${sp.start.slice(11, 16)} to ${sp.end.slice(11, 16)} UTC`}, ${compactNum(sp.total)} in all${share !== null ? `; ${(share * 100).toFixed(1)}% of requests at the peak` : ''}.`,
      });
    }
  }
  return out;
}

async function readChanges(z: ZoneListItem, since: string, until: string, hours: number): Promise<{ events: TimelineEvent[]; source: TimelineSource }> {
  const range = hours <= 24 ? 'day' : 'week';
  const report = await cachedActivity(new URL(`http://console.invalid/api/cloudflare-audit?accountId=${z.accountId}&range=${range}`));
  const acct = report.accounts.find((a) => a.accountId === z.accountId);
  const mine = report.changes.filter((c) => c.zoneId === z.id && within(c.time, since, until));
  const events = mine.map((c): TimelineEvent => ({
    at: c.time, kind: 'config', tone: c.result === 'failure' ? 'warn' : 'info', title: changeTitle(c),
    detail: [c.feature, c.actorEmail || (c.actorTokenName ? `token “${c.actorTokenName}”` : c.actorType)].filter(Boolean).join(' · '),
    href: `/console/cloudflare-activity?accountId=${z.accountId}`,
  }));
  return { events, source: { key: 'config', label: 'Configuration changes (audit log)', status: acct?.error ? 'error' : 'ok', count: events.length, ...(acct?.error ? { message: acct.error } : {}) } };
}

/** Versions of the Workers routed on the zone, and deployments of the Pages projects serving its hosts. */
function readDeployments(z: ZoneListItem, token: string): Promise<{ events: TimelineEvent[]; sources: TimelineSource[] }> {
  return cached(`investigate:deploys:${z.id}`, 10 * 60_000, async () => {
    const events: TimelineEvent[] = [];
    const sources: TimelineSource[] = [];
    try {
      const routes = await cfList<{ pattern?: string; script?: string }>(token, `/zones/${z.id}/workers/routes`, { perPage: 0, max: 500 });
      const scripts = [...new Set(routes.map((r) => r.script).filter((s): s is string => !!s))];
      let n = 0;
      for (const script of scripts.slice(0, MAX_SCRIPTS)) {
        const v = await workerVersions(z.accountId, script).catch(() => null);
        for (const x of v?.versions ?? []) {
          if (!x.createdOn) continue;
          n++;
          events.push({ at: x.createdOn, kind: 'worker', tone: 'info', title: `Worker ${script}: version ${x.label}${x.current ? ' (serving now)' : ''}`, detail: [x.message, x.author, x.source].filter(Boolean).join(' · ') });
        }
      }
      sources.push({ key: 'workers', label: 'Worker versions', status: 'ok', count: n, ...(scripts.length > MAX_SCRIPTS ? { message: `${MAX_SCRIPTS} of ${scripts.length} routed Workers read` } : !scripts.length ? { message: 'No Worker is routed on this zone' } : {}) });
    } catch (e) {
      sources.push({ key: 'workers', label: 'Worker versions', status: 'unavailable', count: 0, message: `${e instanceof Error ? e.message : String(e)} — needs "Zone › Workers Routes › Read" and "Account › Workers Scripts › Read"` });
    }
    try {
      const projects = await cfList<{ name?: string; domains?: string[] }>(token, `/accounts/${z.accountId}/pages/projects`, { perPage: 10, max: 100 });
      const zn = z.name.toLowerCase();
      const mine = projects.filter((p) => p.name && (p.domains ?? []).some((d) => d.toLowerCase() === zn || d.toLowerCase().endsWith(`.${zn}`)));
      let n = 0;
      for (const p of mine.slice(0, MAX_PROJECTS)) {
        for (const d of await pagesDeployments(z.accountId, p.name!).catch(() => [])) {
          if (!d.createdOn) continue;
          n++;
          events.push({ at: d.createdOn, kind: 'pages', tone: 'info', title: `Pages ${p.name}: deployment ${d.label}${d.current ? ' (live)' : ''}`, detail: [d.commit, d.branch].filter(Boolean).join(' · ') });
        }
      }
      sources.push({ key: 'pages', label: 'Pages deployments', status: 'ok', count: n, ...(!mine.length ? { message: 'No Pages project serves this zone’s hosts' } : {}) });
    } catch (e) {
      sources.push({ key: 'pages', label: 'Pages deployments', status: 'unavailable', count: 0, message: `${e instanceof Error ? e.message : String(e)} — needs "Account › Cloudflare Pages › Read"` });
    }
    return { events, sources };
  });
}

/** Stored by monitoring: certificates (monitor_rows), the zone's open findings, alerts Cloudflare sent. */
async function readStored(z: ZoneListItem, since: string, until: string): Promise<{ events: TimelineEvent[]; sources: TimelineSource[] }> {
  const events: TimelineEvent[] = [];
  const sources: TimelineSource[] = [];
  const attempt = async (key: string, label: string, fn: () => Promise<number>) => {
    try { sources.push({ key, label, status: 'ok', count: await fn() }); } catch (e) { sources.push({ key, label, status: 'error', count: 0, message: e instanceof Error ? e.message : String(e) }); }
  };
  await Promise.all([
    attempt('certificates', 'Certificates (monitoring)', async () => {
      const rows = must(await db().from('monitor_rows').select('data').eq('check_id', 'certificates').eq('scope_kind', 'zone').eq('scope_id', z.id).limit(200), 'Reading certificates') as { data: Record<string, unknown> }[];
      let n = 0;
      for (const { data: r } of rows) {
        const exp = typeof r.expires === 'string' ? r.expires : '';
        const name = String(r.name ?? r.kind ?? 'certificate');
        if (within(exp, since, until)) { n++; events.push({ at: exp, kind: 'certificate', tone: 'bad', title: `Certificate expired: ${name}`, detail: [r.kind, r.issuer].filter(Boolean).join(' · '), href: '/console/monitoring/certificates' }); }
        else if (exp > until && typeof r.days === 'number' && r.days <= 14) { n++; events.push({ at: until, kind: 'certificate', tone: 'warn', title: `Certificate expires in ${r.days} days: ${name}`, detail: `Expires ${exp.slice(0, 10)}`, href: '/console/monitoring/certificates' }); }
      }
      return n;
    }),
    attempt('findings', 'Monitoring findings (drift, health checks …)', async () => {
      const rows = must(await db().from('monitor_findings').select('check_id, severity, title, detail, first_seen, last_seen')
        .in('check_id', Object.keys(CHECK)).eq('zone_id', z.id).is('resolved_at', null).gte('last_seen', since).order('first_seen', { ascending: false }).limit(200), 'Reading findings') as { check_id: CheckId; severity: string; title: string; detail: string; first_seen: string }[];
      for (const f of rows) {
        events.push({
          at: f.first_seen < since ? since : f.first_seen, kind: 'finding', tone: f.severity === 'critical' || f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : 'info',
          title: `${CHECK[f.check_id]?.label ?? f.check_id}: ${f.title}`, detail: `${f.first_seen < since ? `Open since ${f.first_seen.slice(0, 16).replace('T', ' ')} UTC. ` : ''}${f.detail ?? ''}`.trim(), href: `/console/monitoring/${f.check_id}`,
        });
      }
      return rows.length;
    }),
    attempt('alerts', 'Alerts Cloudflare sent', async () => {
      const rows = must(await db().from('cloudflare_alerts').select('received_at, alert_type, name, text, account_id, data')
        .gte('received_at', since).lte('received_at', until).order('received_at', { ascending: false }).limit(200), 'Reading alerts') as { received_at: string; alert_type: string | null; name: string | null; text: string | null; account_id: string | null; data: unknown }[];
      const zn = z.name.toLowerCase();
      const mine = rows.filter((a) => (!a.account_id || a.account_id === z.accountId) && `${a.text ?? ''} ${a.name ?? ''} ${JSON.stringify(a.data ?? '')}`.toLowerCase().includes(zn));
      for (const a of mine) events.push({ at: a.received_at, kind: 'alert', tone: 'warn', title: a.name || a.alert_type || 'Cloudflare alert', detail: (a.text ?? '').slice(0, 300), href: '/console/monitoring/alerts' });
      return mine.length;
    }),
  ]);
  return { events, sources };
}

/** GET /api/investigate/timeline?zone=ID&hours=6|24|72|168 */
export async function zoneTimeline(zoneId: string, hours: number, fresh = false, progress: Progress = { done: 0, total: 0 }): Promise<TimelineReport> {
  if (!(TIMELINE_WINDOWS as readonly number[]).includes(hours)) throw new HttpError(400, `Choose ${TIMELINE_WINDOWS.join(', ')} hours`);
  const scope = await zonesOf({ zoneId });
  const z = scope.zones[0];
  return cached(`investigate:timeline:${z.id}:${hours}`, TTL, async () => {
    const bucketMs = hours <= 6 ? 5 * 60_000 : 3_600_000;
    const until = iso(Math.floor(Date.now() / bucketMs) * bucketMs + bucketMs);
    const now = iso(Date.now());
    const since = iso(Date.parse(until) - hours * 3600_000);
    const token = await tokenCache()(scope.list.credentialOf[z.id].id);
    const sources: TimelineSource[] = [];
    const events: TimelineEvent[] = [];
    const fail = (key: string, label: string) => (e: unknown) => { sources.push({ key, label, status: 'error', count: 0, message: e instanceof Error ? e.message : String(e) }); return null; };
    const [traffic, changes, deploys, stored] = await Promise.all([
      token ? readTraffic(z, token, since, now, bucketMs, progress).catch(fail('traffic', 'Traffic (GraphQL Analytics)')) : null,
      readChanges(z, since, now, hours).catch(fail('config', 'Configuration changes (audit log)')),
      token ? readDeployments(z, token).catch(fail('deploys', 'Deployments')) : null,
      readStored(z, since, now).catch(fail('stored', 'Monitoring data')),
    ]);
    if (!token) sources.push({ key: 'token', label: 'Stored credential', status: 'error', count: 0, message: 'The stored credential for this zone could not be decrypted' });
    const series = traffic?.series ?? [];
    if (traffic) { sources.push(traffic.source); events.push(...spikeEvents(series, bucketMs)); }
    if (changes) { sources.push(changes.source); events.push(...changes.events); }
    if (deploys) { sources.push(...deploys.sources); events.push(...deploys.events.filter((e) => within(e.at, since, now))); }
    if (stored) { sources.push(...stored.sources); events.push(...stored.events); }
    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return {
      zoneId: z.id, zoneName: z.name, accountId: z.accountId, accountName: z.accountName,
      hours, since, until: now, bucketMinutes: bucketMs / 60_000, series, events: events.slice(0, 500), sources, generatedAt: new Date().toISOString(),
    };
  }, fresh);
}
