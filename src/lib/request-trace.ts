import 'server-only';
import { cfCall, cfReason, mask, ok, refused } from './cf-read';
import { HttpError } from './http';
import { tokenCache } from './investigate-gql';
import { hostOf, zoneOfHost } from './investigate-scope';
import type { TraceResult, TraceStep } from './investigate-types';
import { listZones } from './zone-explorer';

// URL trace: Cloudflare's request tracer (POST /accounts/{account_id}/request-tracer/trace) runs a
// made-up request through the zone's rules and says which ones matched, phase by phase. It changes
// nothing in Cloudflare and needs only "Account › Request Tracer › Read" ("Allow Request Tracer Read").
// The console always sends skip_response: true, so the traced request is never sent on to the origin.
// The URL's host picks the zone (and so the account and the stored token) from the cached zone list.

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const PROTOCOLS = ['HTTP/1.0', 'HTTP/1.1', 'HTTP/2', 'HTTP/3'];
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const MAX_PAIRS = 30;
const MAX_VALUE = 2048;
const MAX_BODY = 64 * 1024;

export interface TraceInput {
  url?: unknown; method?: unknown; protocol?: unknown;
  headers?: unknown; cookies?: unknown; body?: unknown;
  botScore?: unknown; threatScore?: unknown; skipChallenge?: unknown; country?: unknown;
}

/** Name → value pairs from a list of { name, value } or an object; names checked, values without line breaks. */
function pairs(v: unknown, what: string): Record<string, string> | undefined {
  const list = Array.isArray(v) ? v.map((x) => [String((x as { name?: unknown })?.name ?? '').trim(), String((x as { value?: unknown })?.value ?? '')])
    : v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([k, x]) => [k.trim(), String(x ?? '')]) : [];
  const kept = list.filter(([k]) => k);
  if (!kept.length) return undefined;
  if (kept.length > MAX_PAIRS) throw new HttpError(400, `At most ${MAX_PAIRS} ${what}`);
  for (const [k, x] of kept) {
    if (!HEADER.test(k)) throw new HttpError(400, `Not a valid ${what.replace(/s$/, '')} name: ${k.slice(0, 64)}`);
    if (x.length > MAX_VALUE || /[\r\n\0]/.test(x)) throw new HttpError(400, `The ${what.replace(/s$/, '')} ${k} is too long or has a line break`);
  }
  return Object.fromEntries(kept);
}

const score = (v: unknown, lo: number, hi: number, what: string) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${what} is a whole number from ${lo} to ${hi}`);
  return n;
};

/** Checks the form and builds Cloudflare's request body (never with skip_response off). */
export function traceBody(i: TraceInput) {
  const url = typeof i.url === 'string' ? i.url.trim() : '';
  let u: URL;
  try { u = new URL(url); } catch { throw new HttpError(400, 'Enter a full URL (https://…)'); }
  if (!/^https?:$/.test(u.protocol) || url.length > 4096) throw new HttpError(400, 'Enter an http:// or https:// URL');
  const method = String(i.method ?? 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw new HttpError(400, `Method: one of ${METHODS.join(', ')}`);
  const protocol = i.protocol ? String(i.protocol) : undefined;
  if (protocol && !PROTOCOLS.includes(protocol)) throw new HttpError(400, `Protocol: one of ${PROTOCOLS.join(', ')}`);
  const body = typeof i.body === 'string' && i.body ? i.body : undefined;
  if (body && body.length > MAX_BODY) throw new HttpError(400, 'The body is longer than 64 KB');
  const country = typeof i.country === 'string' && i.country.trim() ? i.country.trim().toUpperCase() : undefined;
  if (country && !/^[A-Z]{2}$/.test(country)) throw new HttpError(400, 'Country: a two-letter code (e.g. DE)');
  const bot = score(i.botScore, 1, 99, 'Bot score');
  const threat = score(i.threatScore, 0, 100, 'Threat score');
  const context = {
    ...(bot !== undefined ? { bot_score: bot } : {}),
    ...(threat !== undefined ? { threat_score: threat } : {}),
    ...(i.skipChallenge === true ? { skip_challenge: true } : {}),
    ...(country ? { geoloc: { iso_code: country } } : {}),
  };
  const headers = pairs(i.headers, 'headers');
  const cookies = pairs(i.cookies, 'cookies');
  return {
    host: u.hostname,
    request: {
      url: u.toString(), method, ...(protocol ? { protocol } : {}), ...(headers ? { headers } : {}), ...(cookies ? { cookies } : {}),
      ...(body && method !== 'GET' && method !== 'HEAD' ? { body: { plain_text: body } } : {}),
      ...(Object.keys(context).length ? { context } : {}),
      skip_response: true,
    },
  };
}

/** Keeps only the documented step fields, to a sane depth, with secret-looking values masked. */
function steps(v: unknown, depth = 0): TraceStep[] {
  if (!Array.isArray(v) || depth > 12) return [];
  return v.slice(0, 500).map((x) => {
    const s = (x ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof s[k] === 'string' ? { [k]: s[k] as string } : {});
    return {
      ...str('step_name'), ...str('type'), ...str('name'), ...str('kind'), ...str('description'), ...str('expression'), ...str('action'),
      ...(typeof s.matched === 'boolean' ? { matched: s.matched } : {}),
      ...(s.action_parameters !== undefined ? { action_parameters: mask(s.action_parameters) } : {}),
      ...(Array.isArray(s.trace) ? { trace: steps(s.trace, depth + 1) } : {}),
    };
  });
}

/** POST /api/investigate/trace: traces the request through the zone's rules. */
export async function traceRequest(input: TraceInput): Promise<TraceResult> {
  const { host, request } = traceBody(input);
  const list = await listZones();
  const zone = zoneOfHost(list.zones.filter((z) => list.credentialOf[z.id]), host);
  if (!zone) throw new HttpError(404, `No zone the stored tokens read covers ${hostOf(host)}`);
  if (!/^[a-f0-9]{32}$/i.test(zone.accountId)) throw new HttpError(409, 'The zone list does not name this zone’s account — read the zone list again');
  const token = await tokenCache()(list.credentialOf[zone.id].id);
  if (!token) throw new HttpError(500, 'The stored credential for this zone could not be decrypted');
  const r = await cfCall<{ status_code?: number; trace?: unknown }>(token, 'POST', `/accounts/${zone.accountId}/request-tracer/trace`, request);
  if (!ok(r)) {
    throw new HttpError(refused(r) ? 403 : 502, refused(r)
      ? `Cloudflare refused the trace: the stored token needs “Account › Request Tracer › Read” for ${zone.accountName || zone.accountId} (${cfReason(r)})`
      : `Cloudflare: ${cfReason(r)}`);
  }
  const res = r.body?.result ?? {};
  return {
    url: request.url, method: request.method, zoneName: zone.name, accountName: zone.accountName,
    statusCode: typeof res.status_code === 'number' ? res.status_code : null, trace: steps(res.trace), generatedAt: new Date().toISOString(),
  };
}
