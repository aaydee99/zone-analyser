import 'server-only';
import { type Progress } from './bg-job';
import { cached, tag } from './cache';
import { cfCall } from './cf-read';
import { errorText, type GqlError } from './traffic';
import { credentialForRun } from './vault';

// GraphQL Analytics reads for the investigation tools (Ray ID lookup, WAF false-positive finder,
// zone timeline). Every query goes through cf-read (the per-token API budget and 429 pause) and,
// on top, waits for room under the same GraphQL budget the traffic pages use (about 300 queries per
// 5 minutes per user: the budgets live in one process-wide map keyed by the token's tag, so traffic
// reads and these reads never together go over it). Only queries are sent (POST is how GraphQL
// takes them); every value in a query is checked first (zone IDs, Ray IDs, times) and goes in as a
// JSON string literal (valid GraphQL), so nothing can leave its string — the traffic pages do the same.

const WINDOW_MS = Number(process.env.TRAFFIC_GQL_WINDOW_MS) || 300_000;
const BUDGET = Number(process.env.TRAFFIC_GQL_BUDGET) || 240;
const COOL_MS = Number(process.env.TRAFFIC_GQL_COOL_MS) || 300_000;
/** Same shape and key as traffic-security.ts's budgets (globalThis.__gqlBudgets). */
interface Budget { sent: number[]; coolUntil: number; queue: Promise<void> }
const gb = globalThis as unknown as { __gqlBudgets?: Map<string, Budget> };
const budgets = (gb.__gqlBudgets ??= new Map());
function budgetOf(token: string) {
  const k = tag(token);
  let b = budgets.get(k);
  if (!b) budgets.set(k, (b = { sent: [], coolUntil: 0, queue: Promise.resolve() }));
  return b;
}
const utcTime = (t: number) => `${new Date(t).toISOString().slice(11, 16)} UTC`;
const LIMITED = /budget|rate.?limit|too many (requests|queries)|quota|limit exceeded/i;
export const LIMIT_CODE = 'query-limit';

function slot(b: Budget, progress?: Progress): Promise<void> {
  const turn = b.queue.then(async () => {
    for (;;) {
      progress?.signal?.throwIfAborted();
      const now = Date.now();
      b.sent = b.sent.filter((t) => t > now - WINDOW_MS);
      const free = b.coolUntil > now ? b.coolUntil : b.sent.length >= BUDGET ? b.sent[0] + WINDOW_MS : 0;
      if (!free) { b.sent.push(now); if (progress) delete progress.note; return; }
      if (progress) progress.note = `Waiting for Cloudflare's analytics query limit (about 300 queries per 5 minutes) — continuing at ${utcTime(free)}`;
      await new Promise((resolve) => setTimeout(resolve, Math.min(free - now + 50, 30_000)));
    }
  });
  b.queue = turn.catch(() => undefined);
  return turn;
}

export interface GqlAnswer<T = Record<string, unknown>> { status: number; data: T | null; errors: GqlError[] }

/** One GraphQL query (with variables). Never throws for Cloudflare's answers; throws when the read is stopped. */
export async function gql<T = Record<string, unknown>>(token: string, query: string, variables: Record<string, unknown>, progress?: Progress, tries = 2): Promise<GqlAnswer<T>> {
  const b = budgetOf(token);
  await slot(b, progress);
  const r = await cfCall<unknown>(token, 'POST', '/graphql', { query, variables }, progress?.signal);
  progress?.signal?.throwIfAborted();
  const body = r.body as unknown as { data?: T | null; errors?: GqlError[] | null } | null;
  const errors: GqlError[] = Array.isArray(body?.errors) ? [...body.errors] : [];
  if (!body) errors.push({ message: r.status ? `Cloudflare answered HTTP ${r.status}` : 'Could not reach the Cloudflare API' });
  else if ((r.status < 200 || r.status >= 300) && !errors.length) errors.push({ message: `Cloudflare answered HTTP ${r.status}` });
  const a: GqlAnswer<T> = { status: r.status, data: body?.data ?? null, errors };
  if (r.status === 429 || errors.some((e) => LIMITED.test(`${e.message ?? ''} ${e.extensions?.code ?? ''}`))) {
    b.coolUntil = Math.max(b.coolUntil, Date.now() + COOL_MS);
    if (tries > 1) return gql<T>(token, query, variables, progress, tries - 1);
    return { status: r.status, data: null, errors: [{ message: `Cloudflare's analytics query limit was reached (${errorText(errors)}) — try again after ${utcTime(b.coolUntil)}`, extensions: { code: LIMIT_CODE } }] };
  }
  return a;
}

export const isPermission = (errors: GqlError[], status: number) => status === 401 || status === 403 || errors.some((e) => /not authori[sz]ed|permission|access/i.test(e.message ?? ''));
export const isLimit = (errors: GqlError[]) => errors.some((e) => e.extensions?.code === LIMIT_CODE);
export { errorText };

// ── What a zone's plan allows ───────────────────────────────────────────────

export type Dataset = 'firewallEventsAdaptive' | 'firewallEventsAdaptiveGroups' | 'httpRequestsAdaptive' | 'httpRequestsAdaptiveGroups';
export const ALL_DATASETS: Dataset[] = ['firewallEventsAdaptive', 'firewallEventsAdaptiveGroups', 'httpRequestsAdaptive', 'httpRequestsAdaptiveGroups'];
export interface Limits { enabled: boolean; maxDuration: number; notOlderThan: number; maxNumberOfFields: number; maxPageSize: number; availableFields: string[] | null }
/** What traffic-security.ts assumes when Cloudflare says nothing. */
export const DEFAULT_LIMITS: Limits = { enabled: true, maxDuration: 259_200, notOlderThan: 2_678_400, maxNumberOfFields: 25, maxPageSize: 10_000, availableFields: null };

/**
 * The zone's limits per dataset, from its `settings` node (how far back, how long one query's range
 * may be, how many fields, which fields the plan offers). Kept for six hours: a plan changes rarely.
 */
export function zoneLimits(token: string, zoneId: string, progress?: Progress): Promise<Record<Dataset, Limits>> {
  return cached(`investigate:limits:${zoneId}`, 6 * 3600_000, async () => {
    if (!ZONE_ID.test(zoneId)) throw new Error('Invalid zone');
    const q = (fields: string) => `{ viewer { zones(filter: { zoneTag: ${J(zoneId)} }) { settings { ${ALL_DATASETS.map((d) => `${d} { ${fields} }`).join(' ')} } } } }`;
    type S = { viewer?: { zones?: { settings?: Partial<Record<Dataset, Partial<Limits> | null>> }[] } };
    let r = await gql<S>(token, q('enabled maxDuration notOlderThan maxNumberOfFields maxPageSize availableFields'), {}, progress);
    if (r.errors.length && !isLimit(r.errors)) r = await gql<S>(token, q('enabled maxDuration notOlderThan maxNumberOfFields maxPageSize'), {}, progress);
    // A spent query limit is not a plan: do not keep defaults for six hours.
    if (isLimit(r.errors)) throw new Error(errorText(r.errors));
    const settings = r.data?.viewer?.zones?.[0]?.settings ?? {};
    return Object.fromEntries(ALL_DATASETS.map((d) => {
      const s = settings[d];
      const n = (k: keyof Limits) => (Number(s?.[k]) > 0 ? Number(s![k]) : (DEFAULT_LIMITS[k] as number));
      return [d, {
        enabled: s ? s.enabled !== false : true,
        maxDuration: n('maxDuration'), notOlderThan: n('notOlderThan'), maxNumberOfFields: n('maxNumberOfFields'), maxPageSize: n('maxPageSize'),
        availableFields: Array.isArray(s?.availableFields) && s!.availableFields!.length ? s!.availableFields!.map(String) : null,
      }];
    })) as Record<Dataset, Limits>;
  });
}

/** Whether the plan offers a field (names or paths ending in it). With no list, it is tried. */
export function offered(limits: Limits, field: string) {
  const list = limits.availableFields;
  return !list || list.some((f) => f === field || f.endsWith(`.${field}`) || f.endsWith(`/${field}`));
}

/** The fields of `wanted` the plan offers. The list is trusted only when it names one of `known` (some datasets list only top-level fields). */
export function fieldsFor(limits: Limits, wanted: string[], known: string[]): { use: string[]; missing: string[] } {
  const trust = known.some((f) => offered(limits, f)) ? limits : { ...limits, availableFields: null };
  const use = wanted.filter((f) => offered(trust, f));
  return { use, missing: wanted.filter((f) => !use.includes(f)) };
}

// ── Tokens ──────────────────────────────────────────────────────────────────

/** Decrypts each stored credential once per read. */
export function tokenCache() {
  const m = new Map<string, Promise<string>>();
  return (credentialId: string) => {
    let p = m.get(credentialId);
    if (!p) {
      p = credentialForRun(credentialId, 'cloudflare').then((c) => c.fields.apiToken || '').catch(() => '');
      m.set(credentialId, p);
    }
    return p;
  };
}

/** A zone ID as the zone list has it; nothing else goes into a query that names a zone. */
export const ZONE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A value as a GraphQL string literal. */
export const J = (v: string) => JSON.stringify(v);
/** Field names go into queries as they are: only plain names. */
export const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
