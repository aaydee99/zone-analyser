// Rules taken from the Cloudflare security skills reviewed for the audit (the installed
// cloudflare-security-analyst skill and its attack playbooks; the community "cloudflare-security"
// hardening skill), turned into plain read-only conditions:
// - admin pages answering with no Cloudflare Access application or WAF rule in front (hardening skill, "Access");
// - login paths with traffic and no rate limit covering them, or no Turnstile widget for the host
//   (playbook "Credential stuffing", hardening skill "Rate limiting" and "Turnstile");
// - signs of credential stuffing and of API enumeration in the zone's requests (playbooks 2 and 4);
// - cached HTML while the forwarding headers used for cache poisoning reach the origin (playbook 3).
// Pure, same discipline as rules.ts. Their active steps (probing the WAF, changing settings) are left
// out: the audit only reads.

import { isBroad, literalPaths, pathMatches } from './expr';
import { API_PATH, LOGIN_MIN, LOGIN_PATH } from './rules-extra';
import { RES, WEB, active, ap, cachingPolicies, capped, ev, obj, optRules, phasePath, plural, ruleName, rulesOf, type Ctx, type Draft, type RuleDef } from './rules';
import type { AccessApp, RequestData, RulesetRule, TurnstileWidget } from './types';
import { compactNum } from '../num';

/** Admin areas (WordPress admin-ajax is public by design, so it is left out). */
export const ADMIN_PATH = /^\/(wp-admin(?!\/admin-ajax\.php)|administrator|admin|phpmyadmin|pma|cpanel|backend|adminer(?:\.php)?)(?=\/|$|\.)/i;
/** Successful (2xx) answers to an admin path before it is reported. */
export const ADMIN_MIN = 20;
/** Credential stuffing: requests to one login path, and the share of them answered 401/422 (failed logins). */
export const STUFFING_MIN = 200, STUFFING_SHARE = 0.3, STUFFING_HIGH = 5_000;
/** API enumeration: distinct IDs under one endpoint, and requests to it. */
export const ENUM_MIN_IDS = 200, ENUM_MIN_REQUESTS = 1_000;
/** Request headers used to poison caches when the origin trusts them (playbook 3). */
export const POISON_HEADERS = ['x-forwarded-host', 'x-original-url', 'x-rewrite-url', 'x-forwarded-scheme', 'x-host'];

const RQ = 'GraphQL httpRequestsAdaptiveGroups';
const ENFORCING = new Set(['block', 'managed_challenge', 'challenge', 'js_challenge']);
const lower = (s: string) => s.toLowerCase();

/** Requests per host and path (all statuses summed), with the per-status counts. */
function byPath(req: RequestData) {
  const m = new Map<string, { host: string; path: string; count: number; status: Map<number, number> }>();
  for (const p of req.paths) {
    const k = `${lower(p.host)} ${p.path}`;
    const x = m.get(k) ?? { host: lower(p.host), path: p.path, count: 0, status: new Map() };
    x.count += p.count;
    x.status.set(p.status, (x.status.get(p.status) ?? 0) + p.count);
    m.set(k, x);
  }
  return [...m.values()];
}
const sumStatus = (st: Map<number, number>, f: (s: number) => boolean) => [...st].reduce((a, [s, n]) => a + (f(s) ? n : 0), 0);

/** An enabled rule that acts (not log) and whose expression covers `path`: zone-wide, or naming the path. */
function covers(r: RulesetRule, path: string, actions?: Set<string>) {
  if (!active(r) || r.action === 'log' || (actions && !actions.has(r.action ?? ''))) return false;
  if (isBroad(r.expression)) return true;
  if (literalPaths(r.expression).some((p) => pathMatches(lower(path), { ...p, path: lower(p.path) }))) return true;
  const seg = path.split('/')[1];
  return !!seg && lower(r.expression ?? '').includes(`"/${lower(seg)}`);
}

/** The Access applications that put a login in front of host + path ("example.com/admin*", "*.example.com"). */
export function accessCovers(apps: AccessApp[], host: string, path: string): AccessApp | undefined {
  const pat = (d: string) => {
    const t = lower(d.trim().replace(/^https?:\/\//, ''));
    const i = t.indexOf('/');
    return { host: i < 0 ? t : t.slice(0, i), path: i < 0 ? '' : t.slice(i).replace(/\*+$/, '') };
  };
  const hostOk = (p: string) => (p.startsWith('*.') ? host.endsWith(p.slice(1)) : p === host);
  return apps.find((a) => (!a.type || a.type === 'self_hosted') && [...(a.self_hosted_domains ?? (a.domain ? [a.domain] : [])), ...(a.destinations ?? []).filter((d) => d.type !== 'private').map((d) => d.uri ?? '')]
    .filter(Boolean).map(pat).some((p) => hostOk(p.host) && (!p.path || p.path === '/' || lower(path).startsWith(p.path))));
}

/** "/api/users/123/orders" → "/api/users/{id}/orders" (numbers, UUIDs and long hex values). */
export const pathTemplate = (path: string) => path.split('/').map((s) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{16,}$/i.test(s) ? '{id}' : s)).join('/');

const ACCESS_RULE: RuleDef = {
  id: 'access.admin_paths', title: 'Admin pages without Cloudflare Access or a WAF rule in front', group: 'access', attackClass: 'Authentication and session', skillRef: WEB,
  needs: ['requests', 'phase:http_request_firewall_custom'], passed: 'No admin path answered successfully without an Access application or a blocking WAF rule in front of it.',
  check: (c: Ctx) => {
    const apps = c.opt<AccessApp[]>('access_apps');
    const custom = rulesOf(c, 'http_request_firewall_custom');
    const seen = new Map<string, { host: string; prefix: string; ok: number; total: number }>();
    for (const p of byPath(c.v<RequestData>('requests'))) {
      const m = ADMIN_PATH.exec(p.path);
      if (!m) continue;
      const k = `${p.host}/${lower(m[1])}`;
      const x = seen.get(k) ?? { host: p.host, prefix: `/${m[1]}`, ok: 0, total: 0 };
      x.ok += sumStatus(p.status, (s) => s >= 200 && s < 300);
      x.total += p.count;
      seen.set(k, x);
    }
    const out: Draft[] = [];
    for (const x of [...seen.values()].filter((x) => x.ok >= ADMIN_MIN).sort((a, b) => b.ok - a.ok)) {
      if (apps && accessCovers(apps, x.host, x.prefix)) continue;
      if (custom.some((r) => covers(r, x.prefix, ENFORCING))) continue;
      out.push({ resource: `${x.host}${x.prefix}`, verdict: 'needs_validation', severity: 'medium', title: `${x.host}${x.prefix} answered ${plural(x.ok, 'request')} with no login at the edge`,
        description: `The admin area ${x.prefix} on ${x.host} returned a success ${compactNum(x.ok)} times in the window, and neither a Cloudflare Access application nor a blocking or challenging WAF rule sits in front of it. Only the application's own login protects it, so password guessing and exploits against the admin code reach the origin.${apps ? '' : ' (Access applications could not be read, so one may exist.)'}`,
        rootCause: 'The admin path is reachable by anyone on the internet.', intendedBehavior: 'Admin areas sit behind Cloudflare Access (an identity login at the edge) or a WAF rule that lets in only known addresses.',
        evidence: [ev(RQ, `${x.host}${x.prefix} requests (2xx / all)`, `${x.ok} / ${x.total}`), ev('GET /accounts/{account}/access/apps', 'applications covering it', apps ? 0 : '(not read)'), ev(phasePath('http_request_firewall_custom'), 'blocking rules naming the path', 0)],
        fix: [`Zero Trust › Access › Applications › Add an application › Self-hosted: domain ${x.host}, path ${x.prefix.slice(1)}*; policy Allow, include your team's emails (free for up to 50 users).`,
          `Or Security › WAF › Custom rules: \`(starts_with(http.request.uri.path, "${x.prefix}") and not ip.src in $admin_ips)\` → Block, with a list of your office or VPN addresses.`],
        validation: `Open https://${x.host}${x.prefix} in a private window from outside your network: an application login form (not a Cloudflare Access page) confirms it. If the admin area is meant to be public (a customer portal named “admin”), this does not apply.` });
    }
    return capped(out, (n) => ({ resource: 'more', verdict: 'needs_validation', severity: 'medium', title: `${n} more admin paths answer without a login at the edge`, description: 'Listed in the requests by path.', rootCause: 'As above.', intendedBehavior: 'As above.', evidence: [], fix: ['As above.'] }));
  },
};

const LOGIN_RATE_RULE: RuleDef = {
  id: 'avail.login_rate_limit', title: 'Rate limits on busy login paths', group: 'availability', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
  needs: ['requests', 'phase:http_ratelimit'], passed: 'Every login path with traffic is covered by an enabled rate limiting rule (or none had traffic).',
  check: (c) => {
    const rl = rulesOf(c, 'http_ratelimit').filter((r) => active(r) && r.action !== 'log');
    if (!rl.length) return { notApplicable: 'The zone has no enforcing rate limiting rule at all (see avail.rate_limits)' };
    const out: Draft[] = byPath(c.v<RequestData>('requests')).filter((p) => LOGIN_PATH.test(p.path) && p.count >= LOGIN_MIN && !rl.some((r) => covers(r, p.path) || LOGIN_PATH.test(r.expression ?? '')))
      .sort((a, b) => b.count - a.count)
      .map((p) => ({ resource: `${p.host}${p.path}`, verdict: 'needs_validation', severity: 'medium', title: `Login path ${p.host}${p.path} got ${plural(p.count, 'request')} and no rate limit covers it`,
        description: 'The zone has rate limiting rules, but none counts requests to this login path, so one client can try passwords as fast as the origin answers.',
        rootCause: 'No enabled rate limiting rule matches the path.', intendedBehavior: 'Login and token endpoints have a per-client limit (playbook: 5 POST requests per minute per IP, then block).',
        evidence: [ev(RQ, `${p.host}${p.path} requests`, p.count), ev(phasePath('http_ratelimit'), 'enforcing rules', rl.map(ruleName).join(', '))],
        fix: [`Security › WAF › Rate limiting rules › Create: \`(http.request.uri.path eq "${p.path}" and http.request.method eq "POST")\`, counting by IP (and a session cookie where the plan allows), 5 requests per 1 minute, action Block for 10 minutes.`],
        validation: 'Check whether the origin limits failed logins itself (account lockout or its own throttling); if it does, the edge limit is extra protection, not a gap.' } satisfies Draft));
    return capped(out, (n) => ({ resource: 'more', verdict: 'needs_validation', severity: 'medium', title: `${n} more login paths have no rate limit`, description: 'As above.', rootCause: 'As above.', intendedBehavior: 'As above.', evidence: [], fix: ['As above.'] }));
  },
};

const TURNSTILE_RULE: RuleDef = {
  id: 'bots.login_turnstile', title: 'Turnstile on hosts with login traffic', group: 'bots', attackClass: 'Authentication and session', skillRef: WEB,
  needs: ['requests', 'turnstile_widgets'], passed: 'Every host with login traffic has a Turnstile widget in the account (or none had login traffic).',
  check: (c) => {
    const widgets = c.v<TurnstileWidget[]>('turnstile_widgets') ?? [];
    const domains = widgets.flatMap((w) => (w.domains ?? []).map(lower));
    const hosts = new Map<string, number>();
    for (const p of byPath(c.v<RequestData>('requests'))) if (LOGIN_PATH.test(p.path)) hosts.set(p.host, (hosts.get(p.host) ?? 0) + p.count);
    const out: Draft[] = [...hosts].filter(([h, n]) => n >= LOGIN_MIN && !domains.some((d) => h === d || h.endsWith(`.${d}`))).sort((a, b) => b[1] - a[1])
      .map(([h, n]) => ({ resource: h, verdict: 'needs_validation', severity: 'low', title: `${h} has login traffic (${plural(n, 'request')}) and no Turnstile widget`,
        description: 'No Turnstile widget in the account is allowed on this host, so its login and sign-up forms probably carry no bot check: scripted logins and form spam are answered like people.',
        rootCause: 'The account has no Turnstile widget for the host.', intendedBehavior: 'Public login, sign-up, reset and contact forms carry Turnstile (free on every plan) and the server verifies the token.',
        evidence: [ev(RQ, `${h} requests to login paths`, n), ev('GET /accounts/{account}/challenges/widgets', 'widget domains', domains.join(', ') || '(none)')],
        fix: [`Turnstile › Add widget: hostname ${h}, mode Managed. Put the widget on the login form and verify the token on the server (siteverify) before checking the password.`],
        validation: 'View the login page source: a challenges.cloudflare.com/turnstile script means a widget from another account; another CAPTCHA, or a login only reached through an identity provider, also settles it.' } satisfies Draft));
    return capped(out, (n) => ({ resource: 'more', verdict: 'needs_validation', severity: 'low', title: `${n} more hosts with login traffic have no Turnstile widget`, description: 'As above.', rootCause: 'As above.', intendedBehavior: 'As above.', evidence: [], fix: ['As above.'] }));
  },
};

const STUFFING_RULE: RuleDef = {
  id: 'traffic.credential_stuffing', title: 'Signs of credential stuffing on login paths', group: 'traffic', attackClass: 'Authentication and session', skillRef: WEB,
  needs: ['requests'], passed: 'No login path had a high share of failed logins (401/422) in the window.',
  check: (c) => {
    const out: Draft[] = [];
    for (const p of byPath(c.v<RequestData>('requests')).filter((p) => LOGIN_PATH.test(p.path) && p.count >= STUFFING_MIN).sort((a, b) => b.count - a.count)) {
      const failed = sumStatus(p.status, (s) => s === 401 || s === 422);
      if (failed / p.count < STUFFING_SHARE) continue;
      const stopped = sumStatus(p.status, (s) => s === 403 || s === 429);
      const covered = (optRules(c, 'http_ratelimit') ?? []).some((r) => covers(r, p.path) || (active(r) && r.action !== 'log' && LOGIN_PATH.test(r.expression ?? '')));
      out.push({ resource: `${p.host}${p.path}`, verdict: 'needs_validation', severity: failed >= STUFFING_HIGH && !covered ? 'high' : 'medium',
        title: `${Math.round((failed / p.count) * 100)}% of ${plural(p.count, 'request')} to ${p.host}${p.path} were failed logins`,
        description: `${compactNum(failed)} requests were answered 401 or 422 — the pattern of credential stuffing or password guessing (many attempts, few successes). ${compactNum(stopped)} were stopped at the edge (403/429).${covered ? ' A rate limiting rule covers the path.' : ' No rate limiting rule covers the path.'}`,
        rootCause: 'Automated login attempts reach the application.', intendedBehavior: 'Attempts are slowed (rate limit), bot-checked (Turnstile, bot score) and leaked passwords flagged before they reach the login code.',
        evidence: [ev(RQ, `${p.host}${p.path} status`, Object.fromEntries([...p.status].sort((a, b) => b[1] - a[1]).slice(0, 6))), ev(phasePath('http_ratelimit'), 'covers the path', covered)],
        fix: [`Rate limit the path: \`(http.request.uri.path eq "${p.path}" and http.request.method eq "POST")\`, 5 per minute per IP, Block 10 minutes.`, 'Turn on leaked credentials detection and challenge `(cf.waf.credential_check.username_and_password_leaked)`.',
          'Add Turnstile to the login form; with Bot Management (Enterprise) block `cf.bot_management.score lt 30` on the path.', 'During an active attack: a Waiting Room on the login page (Business and up), and ask the application team to reset accounts with suspicious logins.'],
        validation: `Security › Analytics: filter on path ${p.path} and look at the client IPs, networks and user agents of the failed logins — many addresses with a few attempts each (residential proxies) or one network with many confirm an attack; one integration retrying a bad password is a false alarm.` });
    }
    return capped(out, (n) => ({ resource: 'more', verdict: 'needs_validation', severity: 'medium', title: `${n} more login paths show failed-login bursts`, description: 'As above.', rootCause: 'As above.', intendedBehavior: 'As above.', evidence: [], fix: ['As above.'] }));
  },
};

const ENUM_RULE: RuleDef = {
  id: 'traffic.api_enumeration', title: 'Signs of API enumeration', group: 'traffic', attackClass: 'Authorization and object access', skillRef: WEB,
  needs: ['requests'], passed: 'No API endpoint was read for many distinct object IDs in the window.',
  check: (c) => {
    const t = new Map<string, { host: string; template: string; ids: Set<string>; count: number }>();
    for (const p of c.v<RequestData>('requests').paths) {
      if (!API_PATH.test(p.path)) continue;
      const template = pathTemplate(p.path);
      if (template === p.path) continue;
      const k = `${lower(p.host)} ${template}`;
      const x = t.get(k) ?? { host: lower(p.host), template, ids: new Set(), count: 0 };
      x.ids.add(p.path);
      x.count += p.count;
      t.set(k, x);
    }
    const rl = optRules(c, 'http_ratelimit');
    const out: Draft[] = [...t.values()].filter((x) => x.ids.size >= ENUM_MIN_IDS && x.count >= ENUM_MIN_REQUESTS).sort((a, b) => b.ids.size - a.ids.size).map((x) => {
      const prefix = x.template.slice(0, x.template.indexOf('{id}'));
      const covered = (rl ?? []).some((r) => covers(r, prefix));
      return { resource: `${x.host}${x.template}`, verdict: 'needs_validation', severity: covered ? 'low' : 'medium',
        title: `${x.host}${x.template} was read for at least ${compactNum(x.ids.size)} different IDs`,
        description: `${compactNum(x.count)} requests walked ${compactNum(x.ids.size)} or more object IDs under one endpoint (only the busiest paths are read, so the real number can be higher). Sequential reads like this are how scrapers copy a catalogue and how an object-level authorization flaw is turned into a data leak.${covered ? ' A rate limiting rule covers the endpoint.' : ' No rate limiting rule covers the endpoint.'}`,
        rootCause: 'One endpoint is read across many objects.', intendedBehavior: 'Per-client limits on data endpoints, authentication required, and (Enterprise) API Shield sequence and schema rules.',
        evidence: [ev(RQ, `${x.host}${x.template}`, `${x.ids.size} paths, ${x.count} requests`), ev(phasePath('http_ratelimit'), 'covers the endpoint', rl ? covered : '(not read)')],
        fix: [`Rate limit the endpoint: \`(starts_with(http.request.uri.path, "${prefix}"))\`, e.g. 30 per minute per IP (or per API key), Managed Challenge or Block.`,
          `Require an Authorization header on it: \`(starts_with(http.request.uri.path, "${prefix}") and not any(len(http.request.headers["authorization"][*]) gt 0))\` → Block, if the API is never anonymous.`,
          'Enterprise: API Shield endpoint management, schema validation and sequence rules; block low bot scores on API paths.'],
        validation: 'Security › Analytics: filter on the endpoint and check whether a few clients account for most of the IDs (enumeration) or many users read their own objects (normal). Also confirm the API checks that the caller owns each object it returns.' } satisfies Draft;
    });
    return capped(out, (n) => ({ resource: 'more', verdict: 'needs_validation', severity: 'low', title: `${n} more API endpoints show enumeration`, description: 'As above.', rootCause: 'As above.', intendedBehavior: 'As above.', evidence: [], fix: ['As above.'] }));
  },
};

const POISON_RULE: RuleDef = {
  id: 'cache.poisoning_headers', title: 'Cache poisoning headers reach the origin', group: 'cache', attackClass: 'Cache poisoning', skillRef: WEB,
  needs: ['phase:http_request_late_transform', 'phase:http_request_cache_settings', 'page_rules'], passed: 'Nothing caches HTML, or the forwarding headers used for cache poisoning are removed before the origin.',
  check: (c) => {
    const policies = cachingPolicies(c);
    if (!policies.length) return [];
    const removed = new Set(rulesOf(c, 'http_request_late_transform').filter(active)
      .flatMap((r) => Object.entries(obj(ap(r).headers)).filter(([, v]) => obj(v).operation === 'remove').map(([k]) => lower(k))));
    const missing = POISON_HEADERS.filter((h) => !removed.has(h));
    if (!missing.length) return [];
    return [{ verdict: 'needs_validation', severity: policies.some((p) => isBroad(p.text) || p.text.endsWith('/*')) ? 'medium' : 'low',
      title: `Cached pages, and ${missing.length} cache-poisoning headers still reach the origin`,
      description: `${policies.map((p) => p.where).slice(0, 3).join(', ')} make${policies.length === 1 ? 's' : ''} pages cacheable, and no request header transform rule removes ${missing.join(', ')}. If the application builds links or redirects from one of them, one crafted request can store a page pointing at an attacker's host in the cache, served to every visitor after.`,
      rootCause: 'Headers the cache key ignores are passed to the origin unchanged.', intendedBehavior: 'Headers the cache does not key on are removed before the origin, so they cannot change a cached response.',
      evidence: [ev(phasePath('http_request_late_transform'), 'removed headers', [...removed].join(', ') || '(none)'), ...policies.slice(0, 3).map((p) => ev(p.source, p.where, p.text))],
      fix: [`Rules › Transform Rules › Modify request header › Create: when \`true\` (all requests), Remove ${missing.map((h) => `\`${h}\``).join(', ')}.`, 'If the origin needs one of them, add it to the cache key instead (cache rule › Cache key › Header).'],
      validation: `With a cache-buster no visitor uses: \`curl -s -H "X-Forwarded-Host: example.invalid" "https://<host>/?cb=$RANDOM" | grep -c example.invalid\` — any match means the origin reflects the header and cached pages can be poisoned; zero for each header listed settles it.` }];
  },
};

export const SKILL_RULES: RuleDef[] = [ACCESS_RULE, LOGIN_RATE_RULE, TURNSTILE_RULE, STUFFING_RULE, ENUM_RULE, POISON_RULE];
