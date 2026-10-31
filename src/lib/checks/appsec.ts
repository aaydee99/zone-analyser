import 'server-only';
import { cfList } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { Problems, daysSince, notAvailable, readStat, type CheckDef } from './common';

// What runs in your visitors' browsers and which APIs you expose: Page Shield's script and connection
// inventory (all plans; scores need Cloudflare's client-side security add-on) and API Shield's saved
// and discovered endpoints. Page Shield scores run from 1 (definitely malicious) to 99 (definitely
// not); Cloudflare publishes no cut-off, so the console calls a script suspicious below 50 and likely
// malicious below 20. A zone where neither product has anything is looked at again once a week.

interface Script { id: string; url?: string; host?: string; first_seen_at?: string; last_seen_at?: string; malware_score?: number; magecart_score?: number; cryptomining_score?: number; js_integrity_score?: number; page_urls?: string[] }
interface Connection { id: string; url?: string; host?: string; first_seen_at?: string; last_seen_at?: string; page_urls?: string[]; malicious_url_categories?: string[]; malicious_domain_categories?: string[] }
interface Operation { operation_id?: string; id?: string; method?: string; host?: string; endpoint?: string; last_updated?: string; state?: string }

const SUSPICIOUS = 50, MALICIOUS = 20;

export const appsec: CheckDef = {
  id: 'appsec', main: 'zone', idleHours: 168,
  units: {
    zone: async (z, ctx) => {
      const p = new Problems();
      const scope = { zoneId: z.id, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
      const scripts: Row[] = [], connections: Row[] = [], apis: Row[] = [];
      const findings: NewFinding[] = [];
      const list = async <T,>(path: string, what: string): Promise<T[]> => {
        try { return await cfList<T>(z.token, `/zones/${z.id}${path}`, { perPage: 100, max: 2_000, signal: ctx.signal }); } catch (err) {
          if (!notAvailable(err)) p.add(what, err);
          return [];
        }
      };
      const [sc, co, saved, found] = await Promise.all([
        list<Script>('/page_shield/scripts', 'scripts'),
        list<Connection>('/page_shield/connections', 'connections'),
        list<Operation>('/api_gateway/operations', 'API endpoints'),
        list<Operation>('/api_gateway/discovery/operations', 'discovered API endpoints'),
      ]);
      let flagged = 0;
      for (const s of sc) {
        const scores = [s.malware_score, s.magecart_score, s.cryptomining_score, s.js_integrity_score].filter((x): x is number => typeof x === 'number');
        const worst = scores.length ? Math.min(...scores) : null;
        if (worst !== null && worst < SUSPICIOUS) flagged++;
        scripts.push({ url: s.url ?? s.host ?? s.id, zone: z.zoneName, firstSeen: s.first_seen_at ?? null, lastSeen: s.last_seen_at ?? null, score: worst, pages: s.page_urls?.length ?? null, _tone: worst === null ? null : worst < MALICIOUS ? 'bad' : worst < SUSPICIOUS ? 'warn' : 'ok', _sort: worst ?? 100 });
        if (worst !== null && worst < SUSPICIOUS) {
          findings.push({ key: `script:${z.id}:${s.id}`, severity: worst < MALICIOUS ? 'critical' : 'high', title: `${worst < MALICIOUS ? 'Likely malicious' : 'Suspicious'} script on ${z.zoneName}: ${s.url ?? s.host ?? s.id}`, detail: `Page Shield scored it ${worst} (1 = definitely malicious, 99 = definitely not).`, ...scope });
        } else if ((daysSince(s.first_seen_at) ?? 99) <= 7) {
          findings.push({ key: `script:${z.id}:${s.id}:new`, severity: 'info', title: `New script on ${z.zoneName}: ${s.url ?? s.host ?? s.id}`, detail: `First seen ${s.first_seen_at}. Check that it belongs on your pages.`, ...scope });
        }
      }
      for (const c of co) {
        const bad = [...(c.malicious_url_categories ?? []), ...(c.malicious_domain_categories ?? [])];
        connections.push({ url: c.url ?? c.host ?? c.id, zone: z.zoneName, firstSeen: c.first_seen_at ?? null, lastSeen: c.last_seen_at ?? null, flagged: bad.join(', '), _tone: bad.length ? 'bad' : null, _sort: bad.length ? 0 : 1 });
        if (bad.length) findings.push({ key: `conn:${z.id}:${c.id}`, severity: 'high', title: `Your pages connect to a flagged address: ${c.url ?? c.host}`, detail: `Cloudflare lists it as ${bad.join(', ')}.`, ...scope });
      }
      for (const o of saved) apis.push({ method: o.method ?? '', endpoint: `${o.host ?? ''}${o.endpoint ?? ''}`, zone: z.zoneName, state: 'saved', updated: o.last_updated ?? null, _tone: 'ok', _sort: 1 });
      const review = found.filter((o) => (o.state ?? 'review') === 'review');
      for (const o of found) apis.push({ method: o.method ?? '', endpoint: `${o.host ?? ''}${o.endpoint ?? ''}`, zone: z.zoneName, state: o.state ?? 'review', updated: o.last_updated ?? null, _tone: (o.state ?? 'review') === 'review' ? 'warn' : null, _sort: (o.state ?? 'review') === 'review' ? 0 : 1 });
      if (review.length) findings.push({ key: `api:${z.id}:review`, severity: 'low', title: `${review.length} discovered API endpoint${review.length === 1 ? '' : 's'} on ${z.zoneName} not reviewed`, detail: 'Save them to protect them with schema validation and rate limits, or ignore them in API Shield.', ...scope });
      const empty = !sc.length && !co.length && !saved.length && !found.length;
      return {
        rows: { scripts, connections, apis }, findings, complete: p.complete, problems: p.list, idle: p.complete && empty,
        counts: { scripts: scripts.length, flagged, connections: connections.length, apis: apis.length },
      };
    },
  },
  sections: [
    { key: 'scripts', title: 'Scripts on your pages', description: 'Lowest Page Shield score first (1 = definitely malicious, 99 = definitely not; scores need the client-side security add-on). Below 50 is shown as suspicious, below 20 as likely malicious.', columns: [{ key: 'url', label: 'Script', kind: 'mono' }, { key: 'zone', label: 'Zone' }, { key: 'score', label: 'Lowest score', kind: 'number' }, { key: 'pages', label: 'Pages', kind: 'number' }, { key: 'firstSeen', label: 'First seen', kind: 'date' }, { key: 'lastSeen', label: 'Last seen', kind: 'date' }], empty: 'Page Shield has seen no scripts, or it is not on for these zones.' },
    { key: 'connections', title: 'Connections your pages make', columns: [{ key: 'url', label: 'Address', kind: 'mono' }, { key: 'zone', label: 'Zone' }, { key: 'flagged', label: 'Flagged as' }, { key: 'firstSeen', label: 'First seen', kind: 'date' }, { key: 'lastSeen', label: 'Last seen', kind: 'date' }], empty: 'No connections seen (Business plan and higher).' },
    { key: 'apis', title: 'API endpoints', description: 'Saved endpoints and the ones API Shield discovered from your traffic.', columns: [{ key: 'method', label: 'Method', kind: 'mono' }, { key: 'endpoint', label: 'Endpoint', kind: 'mono' }, { key: 'zone', label: 'Zone' }, { key: 'state', label: 'State', kind: 'status' }, { key: 'updated', label: 'Updated', kind: 'date' }], empty: 'No API endpoints saved or discovered.' },
  ],
  stats: (t) => [
    { label: 'Scripts', value: t.counts.scripts ?? 0 },
    { label: 'Suspicious or worse', value: t.counts.flagged ?? 0, tone: t.counts.flagged ? 'bad' : 'ok' },
    { label: 'API endpoints', value: t.counts.apis ?? 0 },
    readStat(t, 'Zones read'),
  ],
};
