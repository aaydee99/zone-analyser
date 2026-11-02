// Proof for every finding and recommendation. Pure.
//
// - attachProof: after the rules ran, each evidence value is looked up in the raw answer Cloudflare
//   gave (the snapshot) by code separate from the rule that made it. The value is either found there
//   as shown ("matches", with the record that holds it), or it is something the rule worked out from
//   that answer ("computed", with the answer it read), or a count from traffic analytics ("traffic",
//   reproducible from the report's queries).
// - reproduce: the request that reads the same value again, with the token left as a variable.
// - explain: each finding as a full recommendation — what to do, why, how it helps (with what the
//   change does to the area score and the grade), the risks and how to roll it out, how to confirm
//   it worked, and why it has its priority.
//
// Follows the security-audit skill's reporting rules (VALIDATION-AND-REPORTING.md): a confirmed
// record names its conditions, observed result, remediation and priority rationale; a
// needs-validation record names what is not known and the exact check that settles it.

import { AREAS, penaltyOf, postureOf } from './posture';
import { MASK, SEVERITY_LABEL, SOURCES, redact, type AuditFinding, type AuditReport, type Evidence, type RuleGroup, type Snapshot, type SourceKey } from './types';
import { compactNum } from '../num';

export const RAW_MAX = 1_500;
const API = 'https://api.cloudflare.com/client/v4';

const BY_PATH = new Map(Object.entries(SOURCES).map(([k, v]) => [v.path, k as SourceKey]));
/** The read an evidence source names ("GET /zones/{id}/settings/ssl" → setting:ssl), or null (a derived value such as the window). */
export function sourceKeyOf(source: string): SourceKey | null {
  if (source.startsWith('GraphQL firewallEventsAdaptiveGroups')) return 'events';
  if (source.startsWith('GraphQL httpRequestsAdaptiveGroups')) return 'requests';
  return BY_PATH.get(source) ?? null;
}

const show = (v: unknown) => {
  const t = JSON.stringify(v, null, 1) ?? String(v);
  return t.length > RAW_MAX ? `${t.slice(0, RAW_MAX)}\n… (${compactNum(t.length)} characters in all)` : t;
};
/** The key an evidence field names last ("rule.ratelimit.mitigation_timeout" → mitigation_timeout). */
const lastKey = (field: string) => (field.split('.').pop() ?? '').trim().toLowerCase();
/** A value too common to prove anything unless it sits under the key the evidence names (true, 0, "on"…). */
const common = (v: string) => v.length <= 5;

/** Where the evidence value is in Cloudflare's answer: the record holding it, and whether it sits under the named key. */
function locate(root: unknown, want: string, key: string) {
  let best: { holder: unknown; keyMatch: boolean } | null = null;
  const cut = want.match(/^(.*)… \(\d+ characters\)$/s)?.[1];
  const same = (node: unknown) => {
    if (node === null || node === undefined) return false;
    if (typeof node === 'object') {
      if (!/^[[{]/.test(want)) return false;
      if (Array.isArray(node) ? node.length > 500 : Object.keys(node).length > 500) return false;
    }
    const v = redact('', node);
    return v === want || (!!cut && v.startsWith(cut));
  };
  const walk = (node: unknown, parent: unknown, k: string, depth: number) => {
    if (best?.keyMatch || depth > 14) return;
    if (same(node)) {
      const km = !!key && k.toLowerCase() === key;
      if (!best || km) best = { holder: parent ?? node, keyMatch: km };
      if (km) return;
    }
    if (node && typeof node === 'object') for (const [ck, cv] of Object.entries(node)) walk(cv, node, ck, depth + 1);
  };
  walk(root, undefined, '', 0);
  return best as { holder: unknown; keyMatch: boolean } | null;
}

/** Checks each finding's evidence against the raw reads; sets check, key and raw on each. */
export function attachProof(findings: AuditFinding[], s: Snapshot) {
  for (const f of findings) for (const e of f.evidence) proveOne(e, s);
}
function proveOne(e: Evidence, s: Snapshot) {
  const key = sourceKeyOf(e.source);
  if (!key) { e.check = 'computed'; return; }
  e.key = key;
  if (key === 'events' || key === 'requests' || key === 'events_previous') { e.check = 'traffic'; return; }
  const g = s.reads[key];
  if (g?.state !== 'ok') { e.check = 'computed'; return; }
  const loc = e.value === MASK ? null : locate(g.value, e.value, lastKey(e.field));
  if (loc && (loc.keyMatch || !common(e.value))) { e.check = 'matches'; e.raw = show(loc.holder); return; }
  e.check = 'computed';
  e.raw = show(g.value);
}

/** The request that reads the evidence again (token as $CLOUDFLARE_API_TOKEN), or a pointer to the queries. */
export function reproduce(e: Evidence, r: AuditReport): string | null {
  const key = e.key ?? sourceKeyOf(e.source);
  if (!key) return null;
  if (key === 'events' || key === 'events_previous' || key === 'requests') {
    const ds = key === 'requests' ? 'httpRequestsAdaptiveGroups' : 'firewallEventsAdaptiveGroups';
    const n = (r.queries ?? []).filter((q) => q.dataset === ds).length;
    return n ? `Counted from ${n} ${ds} quer${n === 1 ? 'y' : 'ies'} (listed under “Analytics queries”). Re-run them with: curl -s ${API}/graphql -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" -d '{"query": "<query text>"}'` : null;
  }
  if (key === 'cname_lookups') return 'curl -s -H "accept: application/dns-json" "https://cloudflare-dns.com/dns-query?name=<target>&type=A" (Status 3 = NXDOMAIN)';
  const path = SOURCES[key].path.replace(/^GET /, '').replace('{id}', r.zone.id).replace('{account}', r.zone.accountId);
  return `curl -s "${API}${path}" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"`;
}

export const CHECK_LABEL: Record<NonNullable<Evidence['check']>, string> = {
  matches: 'Matches Cloudflare’s answer', computed: 'Worked out from Cloudflare’s answer', traffic: 'Counted from traffic analytics',
};

// ── Full recommendations ────────────────────────────────────────────────────

/** Side effects of the change and how to roll it out safely, by area (overridden per rule below). */
const RISK_BY_GROUP: Record<RuleGroup, string[]> = {
  transport: ['Visitors on very old browsers or devices can lose access when encryption settings are tightened; Security › Analytics › Traffic shows the TLS versions in use.'],
  origin: ['A DNS change affects everything that uses the name (mail, VPN, partner integrations, monitoring). Check what uses the record before removing or proxying it.'],
  email: ['A strict SPF or DMARC policy drops mail from senders you did not list. Go p=none → quarantine → reject while reading the DMARC reports.'],
  managed: ['A rule that blocks can stop legitimate requests (false positives). Make the change, watch Security › Events for a day, and add a narrow exception for anything legitimate it stops.'],
  waf: ['A rule that blocks can stop legitimate requests. Put a new or changed rule in Log first, read what it matches in Security › Events, then switch it to Block or Managed Challenge.'],
  bypass: ['The rule lets something in on purpose (an office, a monitor, a partner, a payment callback). Find out what before removing it, and give that traffic a narrow skip instead.'],
  bots: ['Bot actions can challenge automation you rely on (uptime monitors, partners, mobile apps, search engines). Keep verified bots allowed and add skips for your own tools first.'],
  access: ['People then sign in through Cloudflare Access: set up the identity provider and test with one person before enforcing the policy.'],
  availability: ['A limit set too low blocks real users who share an address (offices, mobile carriers). Start in Log or with a high threshold, then lower it to just above the normal rate.'],
  cache: ['A cache change changes what visitors are served. Watch the cache hit ratio and origin load after it, and purge the affected paths once.'],
  host: ['The origin may rely on the header or override today. Check the application before changing it.'],
  client: ['A Content-Security-Policy can break scripts, styles and third-party widgets. Ship it as Content-Security-Policy-Report-Only first and fix what it reports.'],
  api: ['Schema validation blocks calls the schema does not describe. Start with the action Log, compare with real traffic, then Block.'],
  edge: ['A change to Worker routes changes which code answers the requests. Test the route on a staging host first.'],
  traffic: ['A rule that starts blocking can stop legitimate requests. Make the change, then watch the rule in Security › Events for 15–30 minutes and again the next day.'],
};
const RISK_BY_RULE: Record<string, string[]> = {
  'tls.ssl_mode': ['Full (strict) fails every request if the origin certificate is invalid, expired or for another name. Run the validation step first; install a Cloudflare Origin CA certificate if needed.'],
  'tls.hsts': ['Browsers remember HSTS for max-age: the host cannot serve plain HTTP again until it expires. Start with a short max-age (a day), then raise it; add includeSubDomains only when every subdomain has HTTPS.'],
  'tls.min_version': ['Clients that only speak TLS 1.0/1.1 (very old Android, Windows 7-era software, old embedded devices) can no longer connect.'],
  'waf.security_level': ['A higher Security Level challenges more visitors with a poor IP reputation, including some shared mobile and VPN addresses.'],
  'access.admin_paths': ['Admins then sign in through Cloudflare Access before the application login. Test with one person; keep a break-glass account or IP rule for emergencies.'],
  'avail.login_rate_limit': ['A login limit too low locks out people who mistype passwords behind a shared address. 5 POSTs per minute per IP is the playbook\'s starting point.'],
  'bots.login_turnstile': ['The login form needs a code change (the widget and the server-side check). Ship the server check in “log only” first if the application allows it.'],
  'cache.poisoning_headers': ['If the application reads one of these headers (some frameworks use X-Forwarded-Host behind a proxy), removing it changes its links or redirects. Check the application first.'],
};
/** What to watch after the change, by area. */
const WATCH_BY_GROUP: Partial<Record<RuleGroup, string>> = {
  managed: 'Security › Events, filtered on the managed ruleset: matches keep coming with the new action, and nothing legitimate is blocked.',
  waf: 'Security › Events, filtered on the rule: it matches what it should, with the new action.',
  bots: 'Security › Bots and Security › Events: the bot share of traffic falls, and the challenge solve rate stays low.',
  availability: 'Security › Events for the rate limit: it triggers on the abusive clients only.',
  traffic: 'Security › Events for the rule changed: the bot and malicious requests it let through now end in Block or a challenge.',
  transport: 'SSL/TLS › Edge Certificates and Analytics › Traffic: no rise in handshake errors (5xx 525/526).',
  cache: 'Caching › Overview: cache hit ratio and origin requests.',
};

export interface FullRecommendation {
  what: string[];
  why: string[];
  helps: string[];
  risks: string[];
  confirm: string[];
  priority: string;
  /** The area score and the grade now, and with this finding fixed. */
  effect: { area: string; from: number | null; to: number | null; grade: string | null; gradeAfter: string | null; score: number | null; scoreAfter: number | null; points: number } | null;
  /** Requests in the window the change acts on (bot or malicious traffic a rule let through), when the traffic shows it. */
  requests: number | null;
}

export function explain(f: AuditFinding, r: AuditReport): FullRecommendation {
  const now = postureOf(r);
  const after = postureOf({ ...r, findings: r.findings.filter((x) => x.fingerprint !== f.fingerprint) });
  const area = AREAS.find((a) => a.groups.includes(f.group));
  const a0 = area ? now.areas.find((x) => x.id === area.id) : undefined;
  const a1 = area ? after.areas.find((x) => x.id === area.id) : undefined;
  const rec = (r.effectiveness?.recommendations ?? []).find((x) => x.fingerprint === f.fingerprint);
  const requests = rec && rec.impact > 0 ? rec.impact : null;
  const facts = f.evidence.filter((e) => e.source !== 'window').slice(0, 4).map((e) => `${e.field}: ${e.value}`);

  const helps = [f.intendedBehavior, `It closes this path for: ${f.attackClass.toLowerCase()}.`];
  if (requests) helps.push(`In the ${r.effectiveness ? `${Math.round(r.effectiveness.hours / 24) || 1}-day` : ''} window, ${compactNum(requests)} bot or malicious requests went through this way; after the change they would have been blocked or challenged.`);
  if (a0 && a1 && a0.score !== null && a1.score !== null && a1.score !== a0.score) helps.push(`${a0.label}: score ${a0.score} → ${a1.score}.`);
  if (now.score !== null && after.score !== null && after.score !== now.score) helps.push(`Overall: ${now.grade} ${now.score}/100 → ${after.grade} ${after.score}/100${after.grade !== now.grade ? ` (grade ${now.grade} → ${after.grade})` : ''}.`);

  const confirm: string[] = [];
  if (f.verdict === 'needs_validation' && f.validation) confirm.push(`Before changing anything, confirm it: ${f.validation}`);
  confirm.push(`After the change, run the audit again: check “${f.ruleId}” should read Passed and this finding should be gone.`);
  const watch = WATCH_BY_GROUP[f.group];
  if (watch) confirm.push(`Watch ${watch}`);

  const sev = SEVERITY_LABEL[f.severity].toLowerCase();
  const priority = f.verdict === 'confirmed'
    ? (f.severity === 'critical' || f.severity === 'high' ? `Fix now: ${sev}, and the zone's own configuration or traffic proves it — nothing else needs checking first.`
      : `${SEVERITY_LABEL[f.severity]}, proven by the configuration or traffic: schedule it after the critical and high items.`)
    : `${SEVERITY_LABEL[f.severity]} if confirmed: the configuration shows the risk, but whether it is real depends on something it cannot show (the validation step). Check that first; it counts half in the score until then.`;

  return {
    what: f.fix,
    why: [f.description, `Root cause: ${f.rootCause}`, ...(facts.length ? [`What the audit read: ${facts.join(' · ')}.`] : [])],
    helps, risks: RISK_BY_RULE[f.ruleId] ?? RISK_BY_GROUP[f.group] ?? [], confirm, priority,
    effect: a0 ? { area: a0.label, from: a0.score, to: a1?.score ?? null, grade: now.grade, gradeAfter: after.grade, score: now.score, scoreAfter: after.score, points: penaltyOf(f) } : null,
    requests,
  };
}
