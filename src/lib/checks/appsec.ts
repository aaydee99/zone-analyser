import 'server-only';
import { cfList, inParallel } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { Problems, daysSince, notAvailable, report, type CheckRunner } from './common';

// What runs in your visitors' browsers and which APIs you expose: Page Shield's script and connection
// inventory (all plans; scores need Cloudflare's client-side security add-on) and API Shield's saved
// and discovered endpoints. Page Shield scores run from 1 (definitely malicious) to 99 (definitely
// not); Cloudflare publishes no cut-off, so the console calls a script suspicious below 50 and likely
// malicious below 20.

interface Script { id: string; url?: string; host?: string; first_seen_at?: string; last_seen_at?: string; malware_score?: number; magecart_score?: number; cryptomining_score?: number; js_integrity_score?: number; page_urls?: string[] }
interface Connection { id: string; url?: string; host?: string; first_seen_at?: string; last_seen_at?: string; page_urls?: string[]; malicious_url_categories?: string[]; malicious_domain_categories?: string[] }
interface Operation { operation_id?: string; id?: string; method?: string; host?: string; endpoint?: string; last_updated?: string; state?: string }

const SUSPICIOUS = 50, MALICIOUS = 20;

export const appsec: CheckRunner = async (ctx) => {
  const started = Date.now();
  const p = new Problems();
  const { zones, problems } = await ctx.zones();
  p.list.push(...problems);
  const scripts: Row[] = [], connections: Row[] = [], apis: Row[] = [];
  const findings: NewFinding[] = [];
  const read = new Set<string>();
  ctx.progress.total = zones.length;
  await inParallel(zones, 3, async (z) => {
    const scope = { zoneId: z.zoneId, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
    let all = true;
    const list = async <T,>(path: string, what: string): Promise<T[]> => {
      try { return await cfList<T>(z.token, `/zones/${z.zoneId}${path}`, { perPage: 100, max: 2_000, signal: ctx.signal }); } catch (err) {
        if (!notAvailable(err)) { all = false; p.add(`${z.zoneName} · ${what}`, err); }
        return [];
      }
    };
    const [sc, co, saved, found] = await Promise.all([
      list<Script>('/page_shield/scripts', 'scripts'),
      list<Connection>('/page_shield/connections', 'connections'),
      list<Operation>('/api_gateway/operations', 'API endpoints'),
      list<Operation>('/api_gateway/discovery/operations', 'discovered API endpoints'),
    ]);
    for (const s of sc) {
      const scores = [s.malware_score, s.magecart_score, s.cryptomining_score, s.js_integrity_score].filter((x): x is number => typeof x === 'number');
      const worst = scores.length ? Math.min(...scores) : null;
      scripts.push({ url: s.url ?? s.host ?? s.id, zone: z.zoneName, firstSeen: s.first_seen_at ?? null, lastSeen: s.last_seen_at ?? null, score: worst, pages: s.page_urls?.length ?? null, _tone: worst === null ? null : worst < MALICIOUS ? 'bad' : worst < SUSPICIOUS ? 'warn' : 'ok' });
      if (worst !== null && worst < SUSPICIOUS) {
        findings.push({ key: `script:${z.zoneId}:${s.id}`, severity: worst < MALICIOUS ? 'critical' : 'high', title: `${worst < MALICIOUS ? 'Likely malicious' : 'Suspicious'} script on ${z.zoneName}: ${s.url ?? s.host ?? s.id}`, detail: `Page Shield scored it ${worst} (1 = definitely malicious, 99 = definitely not).`, ...scope });
      } else if ((daysSince(s.first_seen_at) ?? 99) <= 7) {
        findings.push({ key: `script:${z.zoneId}:${s.id}:new`, severity: 'info', title: `New script on ${z.zoneName}: ${s.url ?? s.host ?? s.id}`, detail: `First seen ${s.first_seen_at}. Check that it belongs on your pages.`, ...scope });
      }
    }
    for (const c of co) {
      const bad = [...(c.malicious_url_categories ?? []), ...(c.malicious_domain_categories ?? [])];
      connections.push({ url: c.url ?? c.host ?? c.id, zone: z.zoneName, firstSeen: c.first_seen_at ?? null, lastSeen: c.last_seen_at ?? null, flagged: bad.join(', '), _tone: bad.length ? 'bad' : null });
      if (bad.length) findings.push({ key: `conn:${z.zoneId}:${c.id}`, severity: 'high', title: `Your pages connect to a flagged address: ${c.url ?? c.host}`, detail: `Cloudflare lists it as ${bad.join(', ')}.`, ...scope });
    }
    for (const o of saved) apis.push({ method: o.method ?? '', endpoint: `${o.host ?? ''}${o.endpoint ?? ''}`, zone: z.zoneName, state: 'saved', updated: o.last_updated ?? null, _tone: 'ok' });
    const review = found.filter((o) => (o.state ?? 'review') === 'review');
    for (const o of found) apis.push({ method: o.method ?? '', endpoint: `${o.host ?? ''}${o.endpoint ?? ''}`, zone: z.zoneName, state: o.state ?? 'review', updated: o.last_updated ?? null, _tone: (o.state ?? 'review') === 'review' ? 'warn' : null });
    if (review.length) findings.push({ key: `api:${z.zoneId}:review`, severity: 'low', title: `${review.length} discovered API endpoint${review.length === 1 ? '' : 's'} on ${z.zoneName} not reviewed`, detail: 'Save them to protect them with schema validation and rate limits, or ignore them in API Shield.', ...scope });
    if (all) read.add(z.zoneId);
    ctx.progress.done++;
  });
  scripts.sort((x, y) => (x.score === null ? 100 : Number(x.score)) - (y.score === null ? 100 : Number(y.score)));
  const flagged = scripts.filter((r) => r._tone === 'bad' || r._tone === 'warn').length;
  return {
    report: report('appsec', started, [
      { label: 'Scripts', value: scripts.length },
      { label: 'Suspicious or worse', value: flagged, tone: flagged ? 'bad' : 'ok' },
      { label: 'Connections', value: connections.length },
      { label: 'API endpoints', value: apis.length },
    ], [
      { key: 'scripts', title: 'Scripts on your pages', description: 'Lowest Page Shield score first (1 = definitely malicious, 99 = definitely not; scores need the client-side security add-on). Below 50 is shown as suspicious, below 20 as likely malicious.', columns: [{ key: 'url', label: 'Script', kind: 'mono' }, { key: 'zone', label: 'Zone' }, { key: 'score', label: 'Lowest score', kind: 'number' }, { key: 'pages', label: 'Pages', kind: 'number' }, { key: 'firstSeen', label: 'First seen', kind: 'date' }, { key: 'lastSeen', label: 'Last seen', kind: 'date' }], rows: scripts, empty: 'Page Shield has seen no scripts, or it is not on for these zones.' },
      { key: 'connections', title: 'Connections your pages make', columns: [{ key: 'url', label: 'Address', kind: 'mono' }, { key: 'zone', label: 'Zone' }, { key: 'flagged', label: 'Flagged as' }, { key: 'firstSeen', label: 'First seen', kind: 'date' }, { key: 'lastSeen', label: 'Last seen', kind: 'date' }], rows: connections, empty: 'No connections seen (Business plan and higher).' },
      { key: 'apis', title: 'API endpoints', description: 'Saved endpoints and the ones API Shield discovered from your traffic.', columns: [{ key: 'method', label: 'Method', kind: 'mono' }, { key: 'endpoint', label: 'Endpoint', kind: 'mono' }, { key: 'zone', label: 'Zone' }, { key: 'state', label: 'State', kind: 'status' }, { key: 'updated', label: 'Updated', kind: 'date' }], rows: apis, empty: 'No API endpoints saved or discovered.' },
    ], p.list, p.partial),
    findings, read,
  };
};
