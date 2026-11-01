// The audit's rule engine: a snapshot of one zone (read.ts) in, findings and a coverage ledger out.
// Pure and deterministic — no Node, network or clock (the snapshot carries "now"). Each rule names the
// security-audit skill's attack class it implements and the skill file it comes from; its condition
// is the code in `check`. A rule whose data could not be read is `not_read` (with the permission that
// reads it), one whose product the plan or zone lacks is `not_applicable` — never `passed`.
//
// Verdicts follow the skill's validation discipline: `confirmed` only when the zone's configuration
// itself proves the security outcome (SSL Flexible ⇒ the origin leg is plain HTTP); `needs_validation`
// when the outcome depends on what configuration cannot show (the origin's behaviour, what an
// unproxied host serves, headers the origin sets), with the exact check to run.

import { inZone, isPrivateIp, originLeaks, takeoverService, type DnsRecord } from '../dns-hygiene';
import { MANAGED_RULESETS, OWASP_RULESET } from '../traffic-types';
import { isBroad, isBroadPattern, norm, onlyClientFields, sensitivePaths } from './expr';
import {
  SOURCES, SEVERITY_RANK, byWorst, emptySummary, redact,
  type AuditFinding, type AuditSummary, type BotConfig, type CertPack, type CnameLookups, type CoverageEntry, type DnsRec, type Evidence, type PageRule,
  type RuleGroup, type RulesetRule, type Severity, type Snapshot, type SourceKey, type Verdict, type WorkerRoute, type ZoneInfo,
} from './types';
import { compactNum } from '@/lib/num';

export const WEB = 'WEB-PROTOCOL-AND-AUTH.md';
export const CLOUD = 'CLOUD-AND-DEPLOYMENT.md';
export const RES = 'RESOURCE-EXHAUSTION-AND-AVAILABILITY.md';
export const CLIENT = 'CLIENT-SIDE.md';
export const ATTACK = 'ATTACK-CLASSES.md';

export const CF_MANAGED = 'efb7b8c949ac4650a09736fc376e9aee';
export const DDOS_L7 = '4d21379b4f9f4bb088e0729962c8b3cf';
/** HSTS max-age the HSTS preload list and most guidance ask for (180 days). */
export const HSTS_MIN_AGE = 15_552_000;
export const CERT_WARN_DAYS = 14;
/** Findings per rule listed one by one; the rest are counted in one more. */
export const PER_RULE_MAX = 25;

/** What a rule reports (the engine adds the fingerprint, rule id, group, attack class and skill file). */
export interface Draft {
  resource?: string;
  verdict: Verdict;
  severity: Severity;
  title: string;
  description: string;
  rootCause: string;
  intendedBehavior: string;
  evidence: Evidence[];
  fix: string[];
  validation?: string;
}
export type Outcome = Draft[] | { notApplicable: string };

export interface Ctx {
  s: Snapshot;
  zone: ZoneInfo | null;
  /** A source's value (the engine only runs a rule when its `needs` were read). */
  v<T>(k: SourceKey): T;
  /** An optional source's value, or undefined when it was not read. */
  opt<T>(k: SourceKey): T | undefined;
}

export interface RuleDef {
  id: string;
  title: string;
  group: RuleGroup;
  attackClass: string;
  skillRef: string;
  needs: SourceKey[];
  /** Plans (Cloudflare's legacy_id) that offer what the rule checks; other plans are not_applicable. */
  plans?: string[];
  /** Reads the zone's DNS records as authoritative (not for partial/CNAME-setup zones). */
  authoritativeDns?: boolean;
  /** What a pass means, for the ledger. */
  passed: string;
  check(c: Ctx): Outcome;
}

export const ev = (source: string, field: string, value: unknown): Evidence => ({ source, field, value: redact(field, value) });
export const setting = (id: string) => `GET /zones/{id}/settings/${id}`;
export const phasePath = (p: string) => `GET /zones/{id}/rulesets/phases/${p}/entrypoint`;
export const valueOf = <T>(c: Ctx, id: string) => (c.v<{ value?: T }>(`setting:${id}` as SourceKey)?.value) as T | undefined;
export const optValue = <T>(c: Ctx, id: string) => (c.opt<{ value?: T }>(`setting:${id}` as SourceKey)?.value) as T | undefined;
export const rulesOf = (c: Ctx, p: string) => c.v<RulesetRule[]>(`phase:${p}` as SourceKey) ?? [];
export const optRules = (c: Ctx, p: string) => c.opt<RulesetRule[]>(`phase:${p}` as SourceKey);
export const active = (r: RulesetRule) => r.enabled !== false;
export const ruleName = (r: RulesetRule) => r.description?.trim() || r.ref || r.id || '(unnamed rule)';
export const ap = (r: RulesetRule) => (r.action_parameters ?? {}) as Record<string, unknown>;
export const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
export const lower = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');
export const plural = (n: number, w: string) => `${compactNum(n)} ${w}${n === 1 ? '' : 's'}`;
export const proxiedWeb = (recs: DnsRec[]) => recs.filter((r) => (r.type === 'A' || r.type === 'AAAA' || r.type === 'CNAME') && r.proxied);
const daysBetween = (a: string, b: string) => Math.floor((Date.parse(a) - Date.parse(b)) / 86_400_000);
/** Cut a list of drafts to PER_RULE_MAX, adding one that counts the rest. */
export function capped(list: Draft[], more: (n: number) => Draft): Draft[] {
  return list.length > PER_RULE_MAX ? [...list.slice(0, PER_RULE_MAX), more(list.length - PER_RULE_MAX)] : list;
}

// ── Transport and session ───────────────────────────────────────────────────

const TRANSPORT: RuleDef[] = [
  {
    id: 'tls.ssl_mode', title: 'SSL/TLS encryption mode', group: 'transport', attackClass: 'Cookie scope and transport', skillRef: WEB,
    needs: ['setting:ssl'], passed: 'SSL mode is Full (strict): the origin certificate is validated.',
    check: (c) => {
      const mode = valueOf<string>(c, 'ssl');
      const e = [ev(setting('ssl'), 'value', mode)];
      if (mode === 'off') return [{ verdict: 'confirmed', severity: 'high', title: 'HTTPS is off for the zone',
        description: 'With SSL set to Off, Cloudflare does not serve the zone over HTTPS: visitors, cookies and credentials travel in plain text between browser and edge.',
        rootCause: 'The zone\'s SSL/TLS encryption mode is Off.', intendedBehavior: 'Every visitor connection is encrypted, and the origin leg is encrypted and authenticated.',
        evidence: e, fix: ['SSL/TLS › Overview › Configure: install a certificate on the origin (a Cloudflare Origin CA certificate works) and choose Full (strict).'] }];
      if (mode === 'flexible') return [{ verdict: 'confirmed', severity: 'high', title: 'Traffic between Cloudflare and the origin is unencrypted (SSL Flexible)',
        description: 'Flexible encrypts only browser → Cloudflare. Cloudflare connects to the origin over plain HTTP, so every request and response — cookies, credentials, form data — crosses the internet unencrypted on the origin leg, and the origin cannot tell HTTP from HTTPS visitors.',
        rootCause: 'The SSL/TLS encryption mode is Flexible.', intendedBehavior: 'The origin leg is encrypted and the origin certificate validated (Full (strict)).',
        evidence: e, fix: ['Install a certificate on the origin (SSL/TLS › Origin Server › Create certificate gives a free Origin CA certificate).', 'SSL/TLS › Overview › Configure: choose Full (strict).'] }];
      if (mode === 'full') return [{ verdict: 'needs_validation', severity: 'medium', title: 'The origin certificate is not validated (SSL Full, not strict)',
        description: 'Full encrypts the origin leg but accepts any certificate — self-signed, expired or for another name — so whoever can intercept or redirect traffic to the origin address can present their own certificate.',
        rootCause: 'The SSL/TLS encryption mode is Full rather than Full (strict).', intendedBehavior: 'Cloudflare validates the origin certificate (Full (strict)).',
        evidence: e, fix: ['Make sure the origin presents a valid certificate for the hostname (publicly trusted or Cloudflare Origin CA).', 'SSL/TLS › Overview › Configure: choose Full (strict).'],
        validation: 'Check the certificate the origin presents: `openssl s_client -connect <origin-ip>:443 -servername <hostname>` — if it is valid for the hostname (or a Cloudflare Origin CA certificate), switching to Full (strict) is safe; if it is self-signed or expired, replace it first.' }];
      return [];
    },
  },
  {
    id: 'tls.min_version', title: 'Minimum TLS version', group: 'transport', attackClass: 'Cookie scope and transport', skillRef: WEB,
    needs: ['setting:min_tls_version'], passed: 'Minimum TLS version is 1.2 or higher.',
    check: (c) => {
      const v = valueOf<string>(c, 'min_tls_version');
      if (v !== '1.0' && v !== '1.1') return [];
      return [{ verdict: 'confirmed', severity: 'medium', title: `Visitors may connect with TLS ${v}`,
        description: `The edge accepts TLS ${v}, deprecated (RFC 8996) and lacking modern cipher suites; clients that negotiate it get weaker protection for their sessions.`,
        rootCause: `Minimum TLS version is set to ${v}.`, intendedBehavior: 'Only TLS 1.2 and 1.3 are accepted.',
        evidence: [ev(setting('min_tls_version'), 'value', v)], fix: ['SSL/TLS › Edge Certificates › Minimum TLS Version: choose TLS 1.2.'] }];
    },
  },
  {
    id: 'tls.tls13', title: 'TLS 1.3', group: 'transport', attackClass: 'Cookie scope and transport', skillRef: WEB,
    needs: ['setting:tls_1_3'], passed: 'TLS 1.3 is on.',
    check: (c) => valueOf<string>(c, 'tls_1_3') !== 'off' ? [] : [{ verdict: 'confirmed', severity: 'low', title: 'TLS 1.3 is off',
      description: 'Clients cannot use TLS 1.3, which removes legacy cipher suites and encrypts more of the handshake.', rootCause: 'The TLS 1.3 setting is off.',
      intendedBehavior: 'TLS 1.3 is offered to clients that support it.', evidence: [ev(setting('tls_1_3'), 'value', 'off')], fix: ['SSL/TLS › Edge Certificates › TLS 1.3: turn on.'] }],
  },
  {
    id: 'tls.always_https', title: 'Always Use HTTPS', group: 'transport', attackClass: 'Cookie scope and transport', skillRef: WEB,
    needs: ['setting:always_use_https', 'setting:ssl'], passed: 'Always Use HTTPS redirects every HTTP request.',
    check: (c) => {
      if (valueOf<string>(c, 'ssl') === 'off') return { notApplicable: 'HTTPS is off for the zone (see tls.ssl_mode)' };
      if (valueOf<string>(c, 'always_use_https') !== 'off') return [];
      return [{ verdict: 'needs_validation', severity: 'medium', title: 'Plain-HTTP requests are not redirected at the edge',
        description: 'Always Use HTTPS is off, so a request to http:// is served (or passed to the origin) over plain HTTP unless something else redirects it. Cookies without the Secure flag and the first request of a visit are then exposed.',
        rootCause: 'Always Use HTTPS is off.', intendedBehavior: 'Every http:// request is redirected to https:// before any content is served.',
        evidence: [ev(setting('always_use_https'), 'value', 'off')], fix: ['SSL/TLS › Edge Certificates › Always Use HTTPS: turn on (or add a single Redirect Rule for http → https if some paths must stay HTTP).'],
        validation: 'Run `curl -sI http://<hostname>/` for each proxied hostname: a 301/308 to https:// from a Redirect Rule or the origin settles it; a 200 confirms the exposure.' }];
    },
  },
  {
    id: 'tls.https_rewrites', title: 'Automatic HTTPS Rewrites', group: 'transport', attackClass: 'Cookie scope and transport', skillRef: WEB,
    needs: ['setting:automatic_https_rewrites'], passed: 'Automatic HTTPS Rewrites is on.',
    check: (c) => valueOf<string>(c, 'automatic_https_rewrites') !== 'off' ? [] : [{ verdict: 'needs_validation', severity: 'low', title: 'Mixed-content links are not rewritten to HTTPS',
      description: 'Pages that reference http:// resources load them insecurely (or the browser blocks them) because Automatic HTTPS Rewrites is off.', rootCause: 'Automatic HTTPS Rewrites is off.',
      intendedBehavior: 'Pages served over HTTPS load only HTTPS resources.', evidence: [ev(setting('automatic_https_rewrites'), 'value', 'off')],
      fix: ['SSL/TLS › Edge Certificates › Automatic HTTPS Rewrites: turn on.'], validation: 'Open the main pages with the browser console open and look for "Mixed Content" warnings; none means the pages already use HTTPS links.' }],
  },
  {
    id: 'tls.hsts', title: 'HTTP Strict Transport Security', group: 'transport', attackClass: 'Cookie scope and transport', skillRef: WEB,
    needs: ['setting:security_header'], passed: 'HSTS is on with a max-age of at least 180 days and includeSubDomains.',
    check: (c) => {
      const h = obj(obj(valueOf<unknown>(c, 'security_header')).strict_transport_security);
      const rules = optRules(c, 'http_response_headers_transform') ?? [];
      const viaRule = rules.filter(active).find((r) => Object.keys(obj(ap(r).headers)).some((k) => k.toLowerCase() === 'strict-transport-security'));
      const src = setting('security_header');
      if (!h.enabled) {
        if (viaRule) return [];
        return [{ verdict: 'needs_validation', severity: 'medium', title: 'HSTS is not set at the edge',
          description: 'Without Strict-Transport-Security, a browser that types the bare name or follows an http:// link makes a first plain-HTTP request that a network attacker can intercept or downgrade (SSL stripping).',
          rootCause: 'HSTS is off in the zone settings and no response header rule sets it.', intendedBehavior: 'Responses carry Strict-Transport-Security with a long max-age, so browsers only ever use HTTPS.',
          evidence: [ev(src, 'strict_transport_security.enabled', h.enabled ?? false)],
          fix: ['SSL/TLS › Edge Certificates › HTTP Strict Transport Security (HSTS): enable, max-age 6 months (15552000) or more; add includeSubDomains once every subdomain serves HTTPS.', 'Turn on preload only when you mean to submit the domain to the browser preload list — it is hard to undo.'],
          validation: 'Run `curl -sI https://<hostname>/ | grep -i strict-transport-security`: if the origin already sends the header with a long max-age, this is settled; if not, the exposure is real.' }];
      }
      const out: Draft[] = [];
      const age = Number(h.max_age ?? 0);
      if (age < HSTS_MIN_AGE) out.push({ resource: 'max_age', verdict: 'confirmed', severity: 'low', title: `HSTS max-age is short (${age} seconds)`,
        description: `Browsers forget the HTTPS-only rule ${age < 86_400 ? 'within a day' : `after ${Math.floor(age / 86_400)} days`}; a visitor who returns after that makes a plain-HTTP first request again.`,
        rootCause: 'The HSTS max-age is below 15552000 (180 days).', intendedBehavior: 'max-age of at least 180 days.',
        evidence: [ev(src, 'strict_transport_security.max_age', age)], fix: ['SSL/TLS › Edge Certificates › HSTS: raise Max Age to 6 months or 12 months.'] });
      if (!h.include_subdomains) out.push({ resource: 'subdomains', verdict: 'confirmed', severity: 'low', title: 'HSTS does not cover subdomains',
        description: `Subdomains are not covered${h.preload ? '; with preload on, the preload list also rejects the domain without includeSubDomains' : ''}. A plain-HTTP subdomain can be used to set or read cookies scoped to the parent domain.`,
        rootCause: 'includeSubDomains is off.', intendedBehavior: 'HSTS applies to every subdomain.', evidence: [ev(src, 'strict_transport_security.include_subdomains', false), ev(src, 'strict_transport_security.preload', h.preload ?? false)],
        fix: ['Confirm every subdomain serves HTTPS, then SSL/TLS › Edge Certificates › HSTS: turn on Apply HSTS policy to subdomains.'] });
      return out;
    },
  },
  {
    id: 'tls.origin_pulls', title: 'Authenticated origin pulls', group: 'transport', attackClass: 'Trusted-proxy and mesh identity bypass', skillRef: CLOUD,
    needs: ['aop', 'setting:ssl', 'dns'], passed: 'Zone-level authenticated origin pulls is on.',
    check: (c) => {
      const mode = valueOf<string>(c, 'ssl');
      if (mode === 'off' || mode === 'flexible') return { notApplicable: `The origin leg is plain HTTP (SSL ${mode}), so the origin cannot ask Cloudflare for a client certificate` };
      if (!proxiedWeb(c.v<DnsRec[]>('dns')).length) return { notApplicable: 'No proxied DNS records: Cloudflare does not connect to an origin' };
      if (c.v<{ enabled?: boolean }>('aop')?.enabled) return [];
      return [{ verdict: 'needs_validation', severity: 'medium', title: 'The origin cannot tell Cloudflare from anyone else',
        description: 'Authenticated origin pulls is off: Cloudflare presents no client certificate, so an origin reachable on the internet accepts the same requests from anyone who knows its address — bypassing the WAF, rate limits and bot protection.',
        rootCause: 'Zone-level authenticated origin pulls is off.', intendedBehavior: 'The origin accepts only connections that present Cloudflare\'s client certificate (or only Cloudflare\'s IP ranges, or a Tunnel).',
        evidence: [ev('GET /zones/{id}/origin_tls_client_auth/settings', 'enabled', false), ev(setting('ssl'), 'value', mode)],
        fix: ['SSL/TLS › Origin Server › Authenticated Origin Pulls: turn on, and configure the origin to require the Cloudflare origin-pull CA certificate.', 'Or allow only Cloudflare IP ranges on the origin firewall, or move the origin behind Cloudflare Tunnel.'],
        validation: 'From a host outside Cloudflare, run `curl -sk --resolve <hostname>:443:<origin-ip> https://<hostname>/` (origin IP from your hosting). An answer means the origin is directly reachable and every edge control can be bypassed; a refused or reset connection settles it.' }];
    },
  },
  {
    id: 'tls.certificates', title: 'Edge certificates', group: 'transport', attackClass: 'Certificate lifecycle fallback', skillRef: WEB,
    needs: ['certificates'], passed: `Every certificate pack is active and has more than ${CERT_WARN_DAYS} days left.`,
    check: (c) => {
      const out: Draft[] = [];
      for (const p of c.v<CertPack[]>('certificates') ?? []) {
        if (p.status === 'deleted' || p.status === 'deletion_timed_out') continue;
        const hosts = (p.hosts ?? []).join(', ') || p.id;
        const exp = (p.certificates ?? []).map((x) => x.expires_on).filter((x): x is string => !!x).sort()[0];
        const left = exp ? daysBetween(exp, c.s.now) : null;
        const src = 'GET /zones/{id}/ssl/certificate_packs?status=all';
        const e = [ev(src, `${p.id}.type`, p.type ?? ''), ev(src, `${p.id}.status`, p.status ?? ''), ev(src, `${p.id}.hosts`, hosts), ...(exp ? [ev(src, `${p.id}.expires_on`, exp)] : [])];
        if (left !== null && left < 0) out.push({ resource: p.id, verdict: 'confirmed', severity: 'high', title: `An edge certificate has expired (${hosts})`, description: `It expired on ${exp!.slice(0, 10)}. If no other certificate covers these hostnames, browsers refuse HTTPS connections to them.`,
          rootCause: 'The certificate was not renewed.', intendedBehavior: 'Certificates renew before they expire.', evidence: e, fix: ['SSL/TLS › Edge Certificates: check the pack\'s validation status and fix domain control validation (DCV), or order a new certificate.'] });
        else if (left !== null && left <= CERT_WARN_DAYS) out.push({ resource: p.id, verdict: 'needs_validation', severity: 'medium', title: `An edge certificate expires in ${left} days (${hosts})`,
          description: 'Managed certificates normally renew about 30 days before expiry; one this close may be failing renewal.', rootCause: 'Renewal has not replaced the certificate yet.', intendedBehavior: 'The certificate renews well before it expires.', evidence: e,
          fix: ['SSL/TLS › Edge Certificates: open the pack and check its validation records; for custom certificates upload the renewed one.'],
          validation: 'Look at the pack\'s validation status in the dashboard: "pending_validation" with a DCV error means renewal is failing; a renewed certificate already listed settles it.' });
        else if (p.status && p.status !== 'active') out.push({ resource: p.id, verdict: 'needs_validation', severity: 'medium', title: `An edge certificate pack is not active (${p.status}: ${hosts})`,
          description: 'A pack that is not active does not serve its hostnames; visitors get another certificate or an error.', rootCause: `The pack's status is ${p.status}.`, intendedBehavior: 'Packs covering live hostnames are active.', evidence: e,
          fix: ['SSL/TLS › Edge Certificates: finish validation for the pack, or delete it if it is not needed.'], validation: 'Check whether another active pack covers the same hostnames (the Universal certificate often does); if yes, this pack is only clutter.' });
      }
      return out;
    },
  },
];

// ── Origin exposure and reachability ────────────────────────────────────────

/** Labels that usually name an origin, a management interface or a non-production host. */
export const RISKY_LABELS = ['origin', 'direct', 'direct-connect', 'admin', 'administrator', 'cpanel', 'whm', 'plesk', 'webmail', 'ftp', 'sftp', 'ssh', 'dev', 'development',
  'staging', 'stage', 'stg', 'test', 'testing', 'qa', 'uat', 'preprod', 'pre-prod', 'jenkins', 'grafana', 'kibana', 'prometheus', 'elastic', 'elasticsearch', 'phpmyadmin',
  'mysql', 'db', 'database', 'vpn', 'internal', 'intranet', 'backend', 'git', 'gitlab', 'jira', 'confluence', 'sonar', 'sonarqube', 'vault', 'k8s', 'kubernetes', 'rancher', 'portainer', 'old', 'legacy', 'backup'];
const RISKY = new Set(RISKY_LABELS);
/** The risky label in the part of `name` below the zone ("origin" in origin2.example.com via its stem), or null. */
export function riskyLabel(name: string, zone: string): string | null {
  const n = lower(name), z = lower(zone);
  if (n === z || !n.endsWith(`.${z}`)) return null;
  for (const label of n.slice(0, -(z.length + 1)).split('.')) {
    const stem = label.replace(/[-_]?\d+$/, '');
    if (RISKY.has(label) || RISKY.has(stem)) return label;
  }
  return null;
}

const ORIGIN: RuleDef[] = [
  {
    id: 'origin.leak', title: 'Unproxied records that reveal a proxied origin', group: 'origin', attackClass: 'Unexpected service or management-plane reachability', skillRef: CLOUD,
    needs: ['dns'], passed: 'No unproxied A/AAAA/CNAME record shares a name, address or target with a proxied one.',
    check: (c) => {
      const leaks = originLeaks(c.v<DnsRec[]>('dns') as DnsRecord[]);
      return capped(leaks.map((l) => ({
        resource: `${lower(l.record.name)}:${l.record.type}:${lower(l.record.content)}`, verdict: 'confirmed' as Verdict, severity: (l.why === 'same-target' ? 'medium' : 'high') as Severity,
        title: `${l.record.name} publishes the origin of ${l.proxied.name}`,
        description: `${l.record.name} (${l.record.type}, not proxied) resolves publicly to ${l.record.content}, ${l.why === 'same-name' ? 'on the same name as' : l.why === 'same-ip' ? 'the same address as' : 'the same target as'} the proxied ${l.proxied.name}. Anyone can look up the origin and send requests to it directly, around the WAF, rate limits and DDoS protection.`,
        rootCause: 'An unproxied DNS record carries the address (or target) a proxied record hides.', intendedBehavior: 'Origin addresses are not published in public DNS; records for proxied services are proxied.',
        evidence: [ev('GET /zones/{id}/dns_records', `${l.record.name} ${l.record.type}`, `${l.record.content} (proxied: false)`), ev('GET /zones/{id}/dns_records', `${l.proxied.name} ${l.proxied.type}`, `${l.proxied.content} (proxied: true)`)],
        fix: [`DNS › Records: proxy ${l.record.name} (orange cloud) if it serves HTTP(S); if it must stay unproxied (mail, SSH), move that service to another address.`, 'Then change the origin\'s address (the old one is now public) and allow only Cloudflare IP ranges or authenticated origin pulls on it.'],
      })), (n) => ({ resource: 'more', verdict: 'confirmed', severity: 'high', title: `${compactNum(n)} more unproxied records reveal proxied origins`, description: `Only the first ${PER_RULE_MAX} are listed one by one.`, rootCause: 'As above.', intendedBehavior: 'As above.', evidence: [ev('GET /zones/{id}/dns_records', 'records not listed', n)], fix: ['Export the DNS records (Zone explorer › DNS CSV) and review every unproxied A/AAAA/CNAME.'] }));
    },
  },
  {
    id: 'origin.risky_names', title: 'Unproxied hosts with management or non-production names', group: 'origin', attackClass: 'Unexpected service or management-plane reachability', skillRef: CLOUD,
    needs: ['dns'], passed: 'No unproxied public record has a management or non-production name.',
    check: (c) => {
      const out: Draft[] = [];
      for (const r of c.v<DnsRec[]>('dns') ?? []) {
        if (r.proxied || !['A', 'AAAA', 'CNAME'].includes(r.type) || (r.type !== 'CNAME' && isPrivateIp(r.content))) continue;
        const label = riskyLabel(r.name, c.s.zoneName);
        if (!label) continue;
        out.push({ resource: `${lower(r.name)}:${r.type}`, verdict: 'needs_validation', severity: 'medium', title: `${r.name} is public and not proxied`,
          description: `The name ("${label}") suggests an origin, a management interface or a non-production system, and the record points straight at ${r.content} with no Cloudflare protection in front.`,
          rootCause: 'A host with a sensitive-looking name is published unproxied.', intendedBehavior: 'Management and non-production systems are not reachable from the internet, or only behind Access / a VPN.',
          evidence: [ev('GET /zones/{id}/dns_records', `${r.name} ${r.type}`, `${r.content} (proxied: false)`)],
          fix: [`If ${r.name} must be reachable: proxy it and protect it with Cloudflare Access (Zero Trust › Access › Applications).`, 'If it is internal: delete the public record and reach it over a VPN or Tunnel.'],
          validation: `Run \`curl -skI https://${r.name}/\` and \`curl -sI http://${r.name}/\` from outside your network: a login page, dashboard or directory listing means it is exposed; a timeout or refusal settles it. Also check which other ports answer on ${r.content} from the hosting firewall rules.` });
      }
      return capped(out, (n) => ({ resource: 'more', verdict: 'needs_validation', severity: 'medium', title: `${compactNum(n)} more unproxied hosts with sensitive names`, description: `Only the first ${PER_RULE_MAX} are listed.`, rootCause: 'As above.', intendedBehavior: 'As above.', evidence: [ev('GET /zones/{id}/dns_records', 'records not listed', n)], fix: ['Review the remaining records in DNS › Records.'], validation: 'As above, for each record.' }));
    },
  },
  {
    id: 'origin.dangling_cname', title: 'CNAMEs to deleted resources on takeover-prone services', group: 'origin', attackClass: 'Wildcard: environment assumptions (DNS is trustworthy) — subdomain takeover', skillRef: ATTACK,
    needs: ['dns', 'cname_lookups'], passed: 'Every CNAME target that was looked up resolves.',
    check: (c) => {
      const look = c.v<CnameLookups>('cname_lookups');
      const out: Draft[] = [];
      const seen = new Set<string>();
      for (const r of c.v<DnsRec[]>('dns') ?? []) {
        if (r.type !== 'CNAME' || !r.content || inZone(r.content, c.s.zoneName)) continue;
        const t = lower(r.content);
        if (look.answers[t] !== 3 || seen.has(lower(r.name))) continue;
        seen.add(lower(r.name));
        const svc = takeoverService(t);
        const e = [ev('GET /zones/{id}/dns_records', `${r.name} CNAME`, `${t} (proxied: ${!!r.proxied})`), ev('DNS-over-HTTPS A ' + t, 'rcode', 'NXDOMAIN')];
        if (svc?.mode === 'nxdomain') out.push({ resource: lower(r.name), verdict: 'confirmed', severity: 'high', title: `${r.name} points at a deleted ${svc.service} resource`,
          description: `${t} does not exist any more (NXDOMAIN). ${svc.service} lets anyone create a resource with that name, and whoever does serves content — and can obtain certificates and read cookies scoped to the domain — on ${r.name}.`,
          rootCause: 'The DNS record outlived the resource it points at.', intendedBehavior: 'Records are deleted together with the resources they point at.', evidence: e,
          fix: [`DNS › Records: delete the CNAME ${r.name}, or recreate the ${svc.service} resource named ${t} under your own subscription.`] });
        else out.push({ resource: lower(r.name), verdict: 'needs_validation', severity: svc ? 'high' : 'medium', title: `${r.name} points at a name that does not exist (${t})`,
          description: svc ? `${svc.service} answers for most names, so a missing one may mean the resource is gone and can be claimed.` : `If the domain of ${t} can be registered, whoever registers it controls ${r.name}.`,
          rootCause: 'The CNAME target does not resolve.', intendedBehavior: 'Every CNAME points at a live resource you control.', evidence: e,
          fix: [`DNS › Records: delete the CNAME ${r.name} if it is not used.`],
          validation: svc ? `Check in your ${svc.service} account whether a resource named ${t} exists; if not, the name can be claimed.` : `Check whether the registered domain of ${t} is still registered (whois); if it is free, anyone can take ${r.name}.` });
      }
      return capped(out, (n) => ({ resource: 'more', verdict: 'needs_validation', severity: 'medium', title: `${compactNum(n)} more CNAMEs point at names that do not exist`, description: `Only the first ${PER_RULE_MAX} are listed.`, rootCause: 'As above.', intendedBehavior: 'As above.', evidence: [ev('DNS-over-HTTPS', 'records not listed', n)], fix: ['Review the remaining CNAMEs in DNS › Records.'], validation: 'As above.' }));
    },
  },
  {
    id: 'origin.wildcard', title: 'Wildcard DNS records', group: 'origin', attackClass: 'Unexpected service or management-plane reachability', skillRef: CLOUD,
    needs: ['dns'], passed: 'No wildcard records.',
    check: (c) => (c.v<DnsRec[]>('dns') ?? []).filter((r) => r.name.startsWith('*.') && ['A', 'AAAA', 'CNAME'].includes(r.type)).slice(0, PER_RULE_MAX).map((r) => ({
      resource: `${lower(r.name)}:${r.type}`, verdict: 'needs_validation' as Verdict, severity: 'info' as Severity, title: `Wildcard record ${r.name} (${r.proxied ? 'proxied' : 'not proxied'})`,
      description: 'Every undefined name under it resolves to the same place, so any hostname — including ones in phishing links or used for cache-key or Host-header tricks — reaches that target.',
      rootCause: 'A wildcard A/AAAA/CNAME record.', intendedBehavior: 'Only names that are meant to exist resolve.', evidence: [ev('GET /zones/{id}/dns_records', `${r.name} ${r.type}`, `${r.content} (proxied: ${!!r.proxied})`)],
      fix: ['If the wildcard is not needed (for example tenant subdomains), replace it with explicit records.'],
      validation: `Request a random name (\`curl -sI https://random-test-1234.${r.name.slice(2)}/\`): if the origin serves a real site for any Host, decide whether that is intended.`,
    })),
  },
];

// ── Email spoofing and certificate issuance ─────────────────────────────────

const txtAt = (recs: DnsRec[], name: string) => recs.filter((r) => r.type === 'TXT' && lower(r.name) === lower(name)).map((r) => r.content.replace(/^"|"$/g, '').replace(/"\s*"/g, ''));

const EMAIL: RuleDef[] = [
  {
    id: 'email.spf', title: 'SPF policy', group: 'email', attackClass: 'Wildcard: environment assumptions (DNS is trustworthy) — sender spoofing', skillRef: ATTACK,
    needs: ['dns', 'zone'], authoritativeDns: true, passed: 'One SPF record that ends in -all or ~all.',
    check: (c) => {
      const spf = txtAt(c.v<DnsRec[]>('dns'), c.s.zoneName).filter((t) => /^v=spf1(\s|$)/i.test(t));
      const src = 'GET /zones/{id}/dns_records';
      if (!spf.length) return [{ verdict: 'needs_validation', severity: 'medium', title: 'No SPF record', description: 'Receivers cannot tell which servers may send mail as this domain, so forged mail from it is easier to deliver.',
        rootCause: `No TXT record starting with v=spf1 at ${c.s.zoneName}.`, intendedBehavior: 'An SPF record lists the senders and ends with -all; a domain that sends no mail publishes "v=spf1 -all".',
        evidence: [ev(src, `${c.s.zoneName} TXT v=spf1`, '(none)')], fix: ['DNS › Records › Add TXT at the zone apex: "v=spf1 -all" if the domain sends no mail, otherwise list your senders (e.g. "v=spf1 include:<provider> -all").'],
        validation: 'Ask the mail owners whether the domain sends mail. Also check DNS › Email Security in the dashboard, which reads the same records.' }];
      if (spf.length > 1) return [{ verdict: 'confirmed', severity: 'medium', title: `${spf.length} SPF records (SPF is then invalid)`, description: 'RFC 7208 allows one SPF record; with several, receivers return permerror and the policy is ignored.',
        rootCause: 'More than one v=spf1 TXT record at the apex.', intendedBehavior: 'Exactly one SPF record.', evidence: spf.map((t, i) => ev(src, `${c.s.zoneName} TXT #${i + 1}`, t)), fix: ['DNS › Records: merge the SPF records into one.'] }];
      const all = /(?:^|\s)([+?~-]?)all(?:\s|$)/i.exec(spf[0]);
      const q = all ? (all[1] || '+') : null;
      if (q === '+' || q === '?') return [{ verdict: 'confirmed', severity: q === '+' ? 'high' : 'medium', title: `SPF ends in ${q}all — ${q === '+' ? 'every server is allowed to send' : 'it authorises nothing'}`,
        description: q === '+' ? 'With +all, any server on the internet passes SPF for this domain.' : 'With ?all (neutral), receivers treat unlisted senders as if there were no SPF at all.',
        rootCause: `The SPF record ends with ${q}all.`, intendedBehavior: 'SPF ends with -all (or ~all while testing).', evidence: [ev(src, `${c.s.zoneName} TXT`, spf[0])], fix: [`DNS › Records: change ${q}all to -all (or ~all) in the SPF record.`] }];
      return [];
    },
  },
  {
    id: 'email.dmarc', title: 'DMARC policy', group: 'email', attackClass: 'Wildcard: environment assumptions (DNS is trustworthy) — sender spoofing', skillRef: ATTACK,
    needs: ['dns', 'zone'], authoritativeDns: true, passed: 'DMARC policy is quarantine or reject.',
    check: (c) => {
      const d = txtAt(c.v<DnsRec[]>('dns'), `_dmarc.${c.s.zoneName}`).filter((t) => /^v=DMARC1/i.test(t));
      const src = 'GET /zones/{id}/dns_records';
      const subzone = c.s.zoneName.split('.').length > 2;
      if (!d.length) return [{ verdict: subzone ? 'needs_validation' : 'confirmed', severity: 'medium', title: 'No DMARC record',
        description: 'Without DMARC, receivers have no instruction to reject mail that fails SPF/DKIM alignment, so mail with this domain in the From header can be forged and delivered.',
        rootCause: `No TXT record starting with v=DMARC1 at _dmarc.${c.s.zoneName}.`, intendedBehavior: 'A DMARC record with p=quarantine or p=reject.',
        evidence: [ev(src, `_dmarc.${c.s.zoneName} TXT`, '(none)')], fix: [`DNS › Records › Add TXT _dmarc: "v=DMARC1; p=none; rua=mailto:<reports address>" to collect reports first, then move to p=quarantine and p=reject.`],
        ...(subzone ? { validation: `This zone may be a subdomain of an organisational domain whose DMARC record applies: check \`dig TXT _dmarc.<organisational domain>\` and its sp= tag.` } : {}) }];
      const p = /(?:^|;)\s*p\s*=\s*([a-z]+)/i.exec(d[0])?.[1]?.toLowerCase();
      if (p === 'none') return [{ verdict: 'confirmed', severity: 'low', title: 'DMARC is in monitoring mode (p=none)', description: 'Receivers report failures but deliver forged mail anyway.',
        rootCause: 'The DMARC policy is p=none.', intendedBehavior: 'p=quarantine or p=reject once reports show legitimate mail aligns.', evidence: [ev(src, `_dmarc.${c.s.zoneName} TXT`, d[0])], fix: ['Review the aggregate reports, then change the record to p=quarantine and later p=reject.'] }];
      return [];
    },
  },
  {
    id: 'email.caa', title: 'CAA records', group: 'email', attackClass: 'Certificate lifecycle fallback', skillRef: WEB,
    needs: ['dns', 'zone'], authoritativeDns: true, passed: 'CAA records limit which CAs may issue certificates.',
    check: (c) => (c.v<DnsRec[]>('dns') ?? []).some((r) => r.type === 'CAA') ? [] : [{ verdict: 'confirmed', severity: 'low', title: 'Any certificate authority may issue certificates for the domain',
      description: 'With no CAA record, every public CA will issue for the domain once domain validation passes — a mis-issuance or a takeover of one subdomain has more CAs to use.', rootCause: 'No CAA records in the zone.',
      intendedBehavior: 'CAA records name the CAs you use (Cloudflare\'s CAs plus any you issue with).', evidence: [ev('GET /zones/{id}/dns_records', 'CAA records', 0)],
      fix: ['DNS › Records › Add CAA records for the CAs you use. Cloudflare adds the CAs its edge certificates need automatically once a CAA record exists.'] }],
  },
  {
    id: 'dns.dnssec', title: 'DNSSEC', group: 'email', attackClass: 'Wildcard: environment assumptions (DNS is trustworthy)', skillRef: ATTACK,
    needs: ['dnssec', 'zone'], authoritativeDns: true, passed: 'DNSSEC is active.',
    check: (c) => {
      const st = c.v<{ status?: string }>('dnssec')?.status ?? '';
      if (st === 'active' || st === 'pending') return [];
      return [{ verdict: 'confirmed', severity: 'low', title: 'DNSSEC is off', description: 'Resolvers cannot verify the zone\'s answers, so a resolver-cache poisoning or on-path attacker can return forged records.',
        rootCause: `DNSSEC status is ${st || 'disabled'}.`, intendedBehavior: 'DNSSEC on, with the DS record at the registrar.', evidence: [ev('GET /zones/{id}/dnssec', 'status', st || 'disabled')],
        fix: ['DNS › Settings › DNSSEC: enable, then add the DS record shown there at your registrar.'] }];
    },
  },
];

// ── WAF and application rules ───────────────────────────────────────────────

export const executes = (rules: RulesetRule[], id: string) => rules.filter((r) => r.action === 'execute' && ap(r).id === id);
export const PAID = ['pro', 'business', 'enterprise'];

const WAF: RuleDef[] = [
  {
    id: 'waf.managed_ruleset', title: 'Cloudflare Managed Ruleset', group: 'managed', attackClass: 'Injection', skillRef: ATTACK,
    needs: ['phase:http_request_firewall_managed', 'zone'], plans: PAID, passed: 'The Cloudflare Managed Ruleset is deployed and enabled.',
    check: (c) => {
      const rules = rulesOf(c, 'http_request_firewall_managed');
      const dep = executes(rules, CF_MANAGED);
      const on = dep.filter((r) => active(r) && obj(ap(r).overrides).enabled !== false);
      if (on.length) return [];
      const src = phasePath('http_request_firewall_managed');
      return [{ verdict: 'confirmed', severity: 'high', title: dep.length ? 'The Cloudflare Managed Ruleset is deployed but disabled' : 'The Cloudflare Managed Ruleset is not deployed',
        description: 'Requests that match Cloudflare\'s signatures for known exploits (CVE payloads, common injection probes) reach the origin unfiltered, although the plan includes the ruleset.',
        rootCause: dep.length ? 'Its deploy rule (or the ruleset override) is disabled.' : 'No rule in the managed-rules phase executes ruleset efb7b8c949ac4650a09736fc376e9aee.',
        intendedBehavior: 'The Cloudflare Managed Ruleset runs on all traffic with its default actions.',
        evidence: [ev(src, 'execute rules', rules.filter((r) => r.action === 'execute').map((r) => `${MANAGED_RULESETS[String(ap(r).id)] ?? ap(r).id}${active(r) ? '' : ' (disabled)'}`).join(', ') || '(none)')],
        fix: ['Security › WAF › Managed rules: deploy (or enable) the Cloudflare Managed Ruleset with its default configuration.'] }];
    },
  },
  {
    id: 'waf.owasp', title: 'OWASP Core Ruleset', group: 'managed', attackClass: 'Injection', skillRef: ATTACK,
    needs: ['phase:http_request_firewall_managed', 'zone'], plans: PAID, passed: 'The OWASP Core Ruleset is deployed and blocks.',
    check: (c) => {
      const dep = executes(rulesOf(c, 'http_request_firewall_managed'), OWASP_RULESET).filter(active);
      const src = phasePath('http_request_firewall_managed');
      if (!dep.length) return [{ verdict: 'confirmed', severity: 'medium', title: 'The OWASP Core Ruleset is not deployed',
        description: 'Generic attack patterns (SQL injection, XSS, path traversal) that do not match a specific signature are not scored or blocked at the edge.', rootCause: 'No rule executes ruleset 4814384a9e5d4991b9815dcfc25d2f1f.',
        intendedBehavior: 'The OWASP Core Ruleset runs, tuned (paranoia level, score threshold) to the application.', evidence: [ev(src, 'OWASP deploy rule', '(none)')],
        fix: ['Security › WAF › Managed rules: deploy the Cloudflare OWASP Core Ruleset, first with action Log for a few days, then with its default Block action.'] }];
      const o = obj(ap(dep[0]).overrides);
      const logOnly = o.enabled === false || o.action === 'log' || (Array.isArray(o.rules) && o.rules.some((r) => obj(r).action === 'log' && String(obj(r).id) === '6179ae15870a4bb7b2d480d4843b323c'));
      if (!logOnly) return [];
      return [{ verdict: 'confirmed', severity: 'medium', title: 'The OWASP Core Ruleset only logs', description: 'It scores requests but its overrides stop it from blocking, so requests over the anomaly threshold still reach the origin.',
        rootCause: 'The OWASP deploy rule overrides its action to log (or disables it).', intendedBehavior: 'Requests over the anomaly score threshold are blocked.',
        evidence: [ev(src, `${ruleName(dep[0])}.action_parameters.overrides`, o)], fix: ['Security › WAF › Managed rules › OWASP Core Ruleset › Configure: set the action of "Inbound Anomaly Score Exceeded" back to Block once the logs show few false positives.'] }];
    },
  },
  {
    id: 'waf.broad_skip', title: 'Custom rules that skip security for everything', group: 'waf', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['phase:http_request_firewall_custom'], passed: 'No enabled skip rule matches every request of the zone or of whole hostnames.',
    check: (c) => rulesOf(c, 'http_request_firewall_custom').filter((r) => active(r) && r.action === 'skip' && isBroad(r.expression)).map((r) => {
      const p = ap(r);
      const what = [p.ruleset === 'current' ? 'all remaining custom rules' : '', ...(Array.isArray(p.phases) ? p.phases.map(String) : []), ...(Array.isArray(p.products) ? p.products.map(String) : [])].filter(Boolean);
      return { resource: r.id ?? ruleName(r), verdict: 'confirmed' as Verdict, severity: 'high' as Severity, title: `“${ruleName(r)}” skips ${what.join(', ') || 'security'} for every request it sees`,
        description: `The expression \`${norm(r.expression)}\` matches the whole zone (or whole hostnames), so the skipped protections never run there.`,
        rootCause: 'A skip rule with an expression that does not narrow it to specific clients or paths.', intendedBehavior: 'Skip rules match only the traffic that needs the exception (a path plus a client you trust, such as your own IP list).',
        evidence: [ev(phasePath('http_request_firewall_custom'), `${ruleName(r)}.expression`, r.expression ?? ''), ev(phasePath('http_request_firewall_custom'), `${ruleName(r)}.action_parameters`, p)],
        fix: [`Security › WAF › Custom rules › “${ruleName(r)}”: narrow the expression (for example \`(ip.src in $trusted_ips and starts_with(http.request.uri.path, "/webhook/"))\`), or disable the rule.`] };
    }),
  },
  {
    id: 'waf.header_skip', title: 'Skip rules decided by client-supplied values', group: 'waf', attackClass: 'Application authorization delegated to cloud metadata', skillRef: CLOUD,
    needs: ['phase:http_request_firewall_custom'], passed: 'No skip rule depends only on headers, user agent, cookies or the query string.',
    check: (c) => rulesOf(c, 'http_request_firewall_custom').filter((r) => active(r) && r.action === 'skip' && !isBroad(r.expression) && onlyClientFields(r.expression)).map((r) => ({
      resource: r.id ?? ruleName(r), verdict: 'needs_validation' as Verdict, severity: 'high' as Severity, title: `“${ruleName(r)}” skips security based on values the client sends`,
      description: 'The rule trusts a header, user agent, cookie or query value and nothing Cloudflare verifies (source IP, client certificate, verified bot). Anyone who learns the value can send it and bypass what the rule skips.',
      rootCause: 'A skip rule keyed on client-controlled request fields.', intendedBehavior: 'Exceptions are bound to something the client cannot forge: an IP list, mTLS, or a verified bot.',
      evidence: [ev(phasePath('http_request_firewall_custom'), `${ruleName(r)}.expression`, r.expression ?? '')],
      fix: [`Security › WAF › Custom rules › “${ruleName(r)}”: add \`and ip.src in $<trusted list>\` or \`and cf.tls_client_auth.cert_verified\` to the expression.`],
      validation: 'Ask who knows the value the rule matches. If it is a fixed secret header from a known partner, check that it is long, random, rotated, and never logged; otherwise treat it as public.',
    })),
  },
  {
    id: 'waf.disabled_rules', title: 'Disabled security rules', group: 'waf', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['phase:http_request_firewall_custom', 'phase:http_request_firewall_managed'], passed: 'No custom or managed-phase rule is disabled.',
    check: (c) => {
      const off = [...rulesOf(c, 'http_request_firewall_custom').map((r) => ({ r, p: 'http_request_firewall_custom' })), ...rulesOf(c, 'http_request_firewall_managed').map((r) => ({ r, p: 'http_request_firewall_managed' }))].filter((x) => x.r.enabled === false);
      if (!off.length) return [];
      return [{ verdict: 'confirmed', severity: 'info', title: `${plural(off.length, 'security rule')} disabled`, description: 'Listed so they are a decision, not an accident: disabled rules protect nothing.',
        rootCause: 'Rules switched off in the dashboard or API.', intendedBehavior: 'Rules that are not needed are deleted; the rest are on.', evidence: off.slice(0, 20).map((x) => ev(phasePath(x.p), ruleName(x.r), `${x.r.action ?? ''} (enabled: false)`)),
        fix: ['Security › WAF: turn each one back on, or delete it if it is no longer needed.'] }];
    },
  },
  {
    id: 'waf.security_level', title: 'Security level', group: 'waf', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['setting:security_level'], passed: 'Security level challenges visitors with a poor IP reputation.',
    check: (c) => {
      const v = valueOf<string>(c, 'security_level');
      if (v === 'under_attack') return [{ verdict: 'confirmed', severity: 'info', title: '“I\'m Under Attack” mode is on', description: 'Every visitor gets an interstitial challenge. Right during an attack; costly in conversions and API clients if left on.',
        rootCause: 'Security level is under_attack.', intendedBehavior: 'Under Attack mode only while an attack is under way.', evidence: [ev(setting('security_level'), 'value', v)], fix: ['Security › Settings: set the security level back to Medium (or use a custom rule for the paths under attack) when the attack ends.'] }];
      if (v !== 'off' && v !== 'essentially_off') return [];
      return [{ verdict: 'confirmed', severity: v === 'off' ? 'medium' : 'low', title: `Security level is ${v === 'off' ? 'off' : 'essentially off'}`,
        description: 'Clients with a bad IP reputation are not challenged, so abusive clients reach expensive pages (search, login, checkout) at no cost to themselves.',
        rootCause: `Security level is ${v}.`, intendedBehavior: 'Security level Medium (the default), or equivalent custom rules.', evidence: [ev(setting('security_level'), 'value', v)], fix: ['Security › Settings › Security level: choose Medium.'] }];
    },
  },
  {
    id: 'waf.browser_check', title: 'Browser integrity check', group: 'waf', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['setting:browser_check'], passed: 'Browser integrity check is on.',
    check: (c) => valueOf<string>(c, 'browser_check') !== 'off' ? [] : [{ verdict: 'confirmed', severity: 'low', title: 'Browser integrity check is off',
      description: 'Requests with missing or obviously forged browser headers (common for spam bots and scanners) are not challenged.', rootCause: 'Browser integrity check is off.',
      intendedBehavior: 'On, with a skip rule for API clients that legitimately send unusual headers.', evidence: [ev(setting('browser_check'), 'value', 'off')], fix: ['Security › Settings › Browser integrity check: turn on.'] }],
  },
  {
    id: 'waf.bot_fight', title: 'Bot Fight Mode / Super Bot Fight Mode', group: 'bots', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['bot', 'zone'], plans: ['free', 'pro', 'business'], passed: 'Automated traffic is challenged or blocked.',
    check: (c) => {
      const b = c.v<BotConfig>('bot') ?? {};
      const free = c.zone?.plan === 'free';
      const src = 'GET /zones/{id}/bot_management';
      if (free ? b.fight_mode : b.sbfm_definitely_automated && b.sbfm_definitely_automated !== 'allow') return [];
      return [{ verdict: 'confirmed', severity: 'low', title: free ? 'Bot Fight Mode is off' : 'Super Bot Fight Mode lets definitely-automated traffic through',
        description: 'Traffic Cloudflare classifies as automated reaches the origin without a challenge (credential stuffing, scraping, inventory hoarding).',
        rootCause: free ? 'fight_mode is false.' : `sbfm_definitely_automated is ${b.sbfm_definitely_automated ?? 'not set'}.`, intendedBehavior: 'Definitely-automated traffic is challenged or blocked; verified bots are allowed.',
        evidence: [free ? ev(src, 'fight_mode', b.fight_mode ?? false) : ev(src, 'sbfm_definitely_automated', b.sbfm_definitely_automated ?? '(not set)')],
        fix: [free ? 'Security › Bots: turn on Bot Fight Mode (it cannot be skipped per path — check API clients first).' : 'Security › Bots › Configure Super Bot Fight Mode: Definitely automated → Block or Managed Challenge.'] }];
    },
  },
];

// ── Availability ────────────────────────────────────────────────────────────

const AVAILABILITY: RuleDef[] = [
  {
    id: 'avail.rate_limits', title: 'Rate limiting rules', group: 'availability', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['phase:http_ratelimit'], passed: 'At least one enabled rate limiting rule.',
    check: (c) => rulesOf(c, 'http_ratelimit').some(active) ? [] : [{ verdict: 'needs_validation', severity: 'medium', title: 'No rate limiting rules',
      description: 'Nothing at the edge bounds how fast one client can hit login, password reset, search or API endpoints, so brute force and expensive-request floods reach the origin.',
      rootCause: 'The rate limiting phase has no enabled rule.', intendedBehavior: 'Login, signup, password reset and costly API paths have per-client limits.',
      evidence: [ev(phasePath('http_ratelimit'), 'enabled rules', 0)], fix: ['Security › WAF › Rate limiting rules › Create: e.g. `(http.request.uri.path eq "/login" and http.request.method eq "POST")`, counting by IP, 5 requests per minute, action Block for 10 minutes.'],
      validation: 'List the paths that do work before authentication (login, reset, search, signup, GraphQL) and check whether the origin limits them itself; any that does not is exposed.' }],
  },
  {
    id: 'avail.ddos_overrides', title: 'HTTP DDoS protection overrides', group: 'availability', attackClass: 'Pre-authentication work imbalance', skillRef: RES,
    needs: ['phase:ddos_l7'], passed: 'HTTP DDoS protection runs at default sensitivity and actions (or no overrides).',
    check: (c) => {
      const out: Draft[] = [];
      for (const r of executes(rulesOf(c, 'ddos_l7'), DDOS_L7)) {
        const o = obj(ap(r).overrides);
        const weak: string[] = [];
        if (!active(r) || o.enabled === false) weak.push('disabled');
        if (o.action === 'log') weak.push('action log');
        if (o.sensitivity_level === 'low' || o.sensitivity_level === 'eoff') weak.push(`sensitivity ${o.sensitivity_level}`);
        for (const x of Array.isArray(o.rules) ? o.rules.map(obj) : []) {
          if (x.enabled === false) weak.push(`rule ${x.id} disabled`);
          if (x.action === 'log') weak.push(`rule ${x.id} log`);
          if (x.sensitivity_level === 'low' || x.sensitivity_level === 'eoff') weak.push(`rule ${x.id} sensitivity ${x.sensitivity_level}`);
        }
        if (weak.length) out.push({ resource: r.id ?? ruleName(r), verdict: 'confirmed', severity: 'high', title: `HTTP DDoS protection is weakened (${weak.slice(0, 3).join(', ')}${weak.length > 3 ? ', …' : ''})`,
          description: 'With these overrides, HTTP floods that Cloudflare detects are only logged or detected later, and the traffic reaches the origin.',
          rootCause: 'An override of the HTTP DDoS attack protection ruleset lowers its sensitivity or action.', intendedBehavior: 'Default sensitivity and actions, with narrow overrides only for traffic proven to be false positives.',
          evidence: [ev(phasePath('ddos_l7'), `${ruleName(r)}.action_parameters.overrides`, o)], fix: ['Security › DDoS › HTTP DDoS attack protection: restore default sensitivity and action, or limit the override with an expression to the traffic that needs it.'] });
        else if (o.sensitivity_level === 'medium') out.push({ resource: r.id ?? ruleName(r), verdict: 'confirmed', severity: 'low', title: 'HTTP DDoS protection sensitivity is lowered to medium',
          description: 'Smaller floods are not mitigated.', rootCause: 'Override sets sensitivity_level medium.', intendedBehavior: 'Default (high) sensitivity unless false positives were seen.', evidence: [ev(phasePath('ddos_l7'), `${ruleName(r)}.action_parameters.overrides.sensitivity_level`, 'medium')], fix: ['Security › DDoS: set sensitivity back to High if the reason for the override is gone.'] });
      }
      return out;
    },
  },
  {
    id: 'avail.dev_mode', title: 'Development mode', group: 'availability', attackClass: 'Security-control precedence drift', skillRef: CLOUD,
    needs: ['setting:development_mode'], passed: 'Development mode is off.',
    check: (c) => valueOf<string>(c, 'development_mode') !== 'on' ? [] : [{ verdict: 'confirmed', severity: 'medium', title: 'Development mode is on',
      description: 'The cache is bypassed, so every request goes to the origin — the origin loses the cache\'s absorption of traffic spikes and floods. It turns itself off after three hours.', rootCause: 'Development mode is on.',
      intendedBehavior: 'Off outside short debugging sessions.', evidence: [ev(setting('development_mode'), 'value', 'on')], fix: ['Caching › Configuration › Development Mode: turn off.'] }],
  },
];

// ── Cache poisoning and deception ───────────────────────────────────────────

interface CachePolicy { where: string; source: string; text: string; overrides: boolean; armored: boolean; resource: string }

/** Cache rules and page rules that make responses cacheable beyond static files. */
function cachingPolicies(c: Ctx): CachePolicy[] {
  const out: CachePolicy[] = [];
  for (const r of optRules(c, 'http_request_cache_settings') ?? []) {
    if (!active(r) || r.action !== 'set_cache_settings' || ap(r).cache !== true) continue;
    out.push({ where: `cache rule “${ruleName(r)}”`, source: phasePath('http_request_cache_settings'), text: r.expression ?? '', overrides: obj(ap(r).edge_ttl).mode === 'override_origin',
      armored: obj(ap(r).cache_key).cache_deception_armor === true, resource: `rule:${r.id ?? ruleName(r)}` });
  }
  for (const p of c.opt<PageRule[]>('page_rules') ?? []) {
    if (p.status && p.status !== 'active') continue;
    const acts = p.actions ?? [];
    if (!acts.some((a) => a.id === 'cache_level' && a.value === 'cache_everything')) continue;
    const url = p.targets?.[0]?.constraint?.value ?? '';
    out.push({ where: `page rule ${url}`, source: 'GET /zones/{id}/pagerules', text: url, overrides: acts.some((a) => a.id === 'edge_cache_ttl'),
      armored: acts.some((a) => a.id === 'cache_deception_armor' && a.value === 'on'), resource: `pagerule:${p.id}` });
  }
  return out;
}
const policyBroad = (p: CachePolicy) => (p.resource.startsWith('pagerule:') ? isBroadPattern(p.text) : isBroad(p.text));

const CACHE: RuleDef[] = [
  {
    id: 'cache.private_caching', title: 'Cache-everything rules on per-user paths', group: 'cache', attackClass: 'Cache deception and private-response caching', skillRef: WEB,
    needs: ['phase:http_request_cache_settings', 'page_rules'], passed: 'No rule caches HTML/dynamic responses on sensitive or zone-wide paths.',
    check: (c) => cachingPolicies(c).flatMap((p): Draft[] => {
      const sens = sensitivePaths(p.text);
      const broad = policyBroad(p);
      if (!sens.length && !broad) return [];
      const e = [ev(p.source, `${p.where} matches`, p.text), ev(p.source, 'edge TTL', p.overrides ? 'overrides origin Cache-Control' : 'respects origin Cache-Control')];
      if (sens.length && p.overrides) return [{ resource: p.resource, verdict: 'confirmed', severity: 'high', title: `The ${p.where} caches ${sens.join(', ')} regardless of the origin`,
        description: `Responses under ${sens.join(', ')} usually belong to one signed-in user. The rule makes them cacheable and ignores the origin's Cache-Control, so one user's page (account details, tokens, CSRF values) can be served from cache to the next visitor.`,
        rootCause: 'A cache-everything rule with an edge TTL that overrides the origin covers per-user paths.', intendedBehavior: 'Per-user and authenticated responses are never cached at the edge.', evidence: e,
        fix: [`Exclude ${sens.join(', ')} from the ${p.where} (e.g. \`and not starts_with(http.request.uri.path, "${sens[0]}")\`), or add a Bypass cache rule for those paths above it.`] }];
      return [{ resource: p.resource, verdict: 'needs_validation', severity: sens.length ? 'high' : 'medium', title: `The ${p.where} makes ${sens.length ? sens.join(', ') : 'every path'} cacheable`,
        description: `Whether private pages get cached depends on the Cache-Control headers the origin sends${p.overrides ? ' — and this rule overrides them' : ''}: a response without "private"/"no-store" is cached and served to others.`,
        rootCause: 'Cache eligibility is granted on paths that may serve per-user content.', intendedBehavior: 'Only static or public content is cache-eligible; per-user responses carry Cache-Control: private or no-store.', evidence: e,
        fix: [`Narrow the ${p.where} to static paths or extensions, or add a Bypass cache rule for logged-in paths and requests with session cookies.`],
        validation: 'Sign in, open an account page twice and check the response headers: `cf-cache-status: HIT` or a missing `Cache-Control: private/no-store` on any per-user page confirms the exposure.' }];
    }),
  },
  {
    id: 'cache.deception_armor', title: 'Cache Deception Armor', group: 'cache', attackClass: 'Cache deception and private-response caching', skillRef: WEB,
    needs: ['phase:http_request_cache_settings', 'page_rules'], passed: 'Every cache-everything rule has Cache Deception Armor, or there are none.',
    check: (c) => {
      const open = cachingPolicies(c).filter((p) => !p.armored);
      if (!open.length) return [];
      return [{ verdict: 'needs_validation', severity: 'medium', title: `${plural(open.length, 'cache-everything rule')} without Cache Deception Armor`,
        description: 'A request like /account/profile.css can make the edge cache the dynamic /account/profile page as if it were a stylesheet, if the origin ignores the extension. Cache Deception Armor caches such responses only when the content type matches the extension.',
        rootCause: 'Cache-eligibility rules without Cache Deception Armor.', intendedBehavior: 'Cache Deception Armor on for every rule that caches beyond the default static extensions.',
        evidence: open.slice(0, 10).map((p) => ev(p.source, p.where, 'cache_deception_armor: off')), fix: ['Caching › Cache Rules › edit each rule › Cache key › Cache deception armor: on (page rules: add the Cache Deception Armor setting).'],
        validation: 'Request an authenticated page with a fake static suffix (`/account/x.css`) while signed in: if the origin answers 200 with the account page, the rule is exploitable without the armor.' }];
    },
  },
  {
    id: 'cache.unkeyed_query', title: 'Cache keys that ignore the query string', group: 'cache', attackClass: 'Web cache poisoning through unkeyed input', skillRef: WEB,
    needs: ['phase:http_request_cache_settings', 'setting:cache_level'], passed: 'Query strings are part of the cache key.',
    check: (c) => {
      const out: Draft[] = [];
      if (valueOf<string>(c, 'cache_level') === 'simplified') out.push({ resource: 'cache_level', verdict: 'needs_validation', severity: 'medium', title: 'The zone caches by URL without the query string (Ignore Query String)',
        description: 'Requests that differ only in their query share one cache entry. If the origin reflects a query parameter in the response, one request can poison the cached copy every visitor gets.',
        rootCause: 'Caching level is "Ignore query string" (simplified).', intendedBehavior: 'Query strings are part of the cache key unless the content is truly static.', evidence: [ev(setting('cache_level'), 'value', 'simplified')],
        fix: ['Caching › Configuration › Caching Level: Standard.'], validation: 'Request a cacheable page with `?test=<random>` and check whether the value appears in the body or headers; if it does, a poisoned copy would be served to others.' });
      for (const r of rulesOf(c, 'http_request_cache_settings')) {
        if (!active(r) || r.action !== 'set_cache_settings') continue;
        const ck = obj(obj(ap(r).cache_key).custom_key);
        const qs = obj(ck.query_string);
        const ex = obj(qs.exclude);
        if (!(ex.all === true || (Array.isArray(qs.exclude) && qs.exclude.includes('*')) || (Array.isArray(ex.list) && ex.list.includes('*')))) continue;
        out.push({ resource: `rule:${r.id ?? ruleName(r)}`, verdict: 'needs_validation', severity: 'medium', title: `Cache rule “${ruleName(r)}” drops the query string from the cache key`,
          description: 'Every query variant shares one cache entry, so a query value the origin reflects can be cached and served to everyone.', rootCause: 'custom_key.query_string excludes all parameters.',
          intendedBehavior: 'Only parameters that do not change the response are left out of the key.', evidence: [ev(phasePath('http_request_cache_settings'), `${ruleName(r)}.cache_key.custom_key.query_string`, qs)],
          fix: [`Caching › Cache Rules › “${ruleName(r)}” › Cache key: include the query string, or exclude only named tracking parameters (utm_*, fbclid).`],
          validation: 'Request a page the rule covers with a random query value and look for it in the response; reflected values make the key unsafe.' });
      }
      return out;
    },
  },
];

// ── Host and forwarded-header trust ─────────────────────────────────────────

const HOST: RuleDef[] = [
  {
    id: 'host.origin_overrides', title: 'Origin rules that rewrite Host or SNI', group: 'host', attackClass: 'Host and forwarded-header trust', skillRef: WEB,
    needs: ['phase:http_request_origin'], passed: 'No origin rule overrides the Host header, SNI or origin host.',
    check: (c) => rulesOf(c, 'http_request_origin').filter((r) => active(r) && r.action === 'route').flatMap((r): Draft[] => {
      const p = ap(r);
      const parts = [p.host_header ? `Host → ${p.host_header}` : '', obj(p.origin).host ? `origin → ${obj(p.origin).host}` : '', obj(p.sni).value ? `SNI → ${obj(p.sni).value}` : ''].filter(Boolean);
      if (!parts.length) return [];
      return [{ resource: r.id ?? ruleName(r), verdict: 'needs_validation', severity: 'low', title: `Origin rule “${ruleName(r)}” sends a different host to the origin (${parts.join(', ')})`,
        description: 'The origin sees a host that differs from what the visitor asked for. If the application builds absolute URLs, redirects or password-reset links from X-Forwarded-Host or the original Host, or if two hostnames share a cache key here, responses can point visitors at the wrong host.',
        rootCause: 'A route action overrides the Host header, SNI or the resolved origin.', intendedBehavior: 'The application builds links from a fixed, configured base URL and ignores forwarded host headers.',
        evidence: [ev(phasePath('http_request_origin'), `${ruleName(r)}.expression`, r.expression ?? ''), ev(phasePath('http_request_origin'), `${ruleName(r)}.action_parameters`, p)],
        fix: ['Keep the rule if it is intended; make sure the origin uses a configured canonical host for links, not request headers.'],
        validation: 'Send a request through the rule with `X-Forwarded-Host: attacker.example` and check that no link, redirect or e-mail (password reset) uses that host.' }];
    }),
  },
  {
    id: 'host.true_client_ip', title: 'True-Client-IP header', group: 'host', attackClass: 'Host and forwarded-header trust', skillRef: WEB,
    needs: ['setting:true_client_ip_header'], passed: 'True-Client-IP is not added.',
    check: (c) => valueOf<string>(c, 'true_client_ip_header') !== 'on' ? [] : [{ verdict: 'needs_validation', severity: 'info', title: 'Cloudflare adds a True-Client-IP header',
      description: 'The origin may use it as the visitor\'s address for allow-lists or rate limits. That is only safe if the origin accepts it from Cloudflare alone; a client that reaches the origin directly can send its own.',
      rootCause: 'True-Client-IP header is on.', intendedBehavior: 'The origin trusts client-address headers only on connections from Cloudflare.', evidence: [ev(setting('true_client_ip_header'), 'value', 'on')],
      fix: ['Nothing to change at Cloudflare if the origin is locked to Cloudflare; otherwise lock the origin (authenticated origin pulls or Cloudflare IP ranges).'],
      validation: 'Check the origin configuration: True-Client-IP / CF-Connecting-IP must only be trusted when the connection comes from a Cloudflare IP range.' }],
  },
];

// ── Client-side protections ─────────────────────────────────────────────────

const SEC_HEADERS = ['content-security-policy', 'x-frame-options', 'x-content-type-options'];

const CLIENT_RULES: RuleDef[] = [
  {
    id: 'client.security_headers', title: 'Security headers set at the edge', group: 'client', attackClass: 'Clickjacking', skillRef: CLIENT,
    needs: ['phase:http_response_headers_transform', 'managed_headers', 'setting:security_header'], passed: 'CSP, X-Frame-Options and X-Content-Type-Options are set at the edge.',
    check: (c) => {
      const set = new Set<string>();
      for (const r of rulesOf(c, 'http_response_headers_transform')) if (active(r)) for (const [k, v] of Object.entries(obj(ap(r).headers))) if (obj(v).operation !== 'remove') set.add(k.toLowerCase());
      const managed = (c.v<{ managed_response_headers?: { id: string; enabled?: boolean }[] }>('managed_headers')?.managed_response_headers ?? []).find((h) => h.id === 'add_security_headers');
      // Cloudflare's "Add security headers" managed transform sets X-Content-Type-Options and X-Frame-Options (SAMEORIGIN), among others.
      if (managed?.enabled) { set.add('x-content-type-options'); set.add('x-frame-options'); }
      if (obj(obj(optValue<unknown>(c, 'security_header')).strict_transport_security).nosniff) set.add('x-content-type-options');
      const missing = SEC_HEADERS.filter((h) => !set.has(h));
      if (!missing.length) return [];
      return [{ verdict: 'needs_validation', severity: 'low', title: `Not set at the edge: ${missing.join(', ')}`,
        description: 'Without frame protection a state-changing page can be framed (clickjacking); without a CSP, an injected script runs with full page rights; without nosniff, uploaded files can be interpreted as scripts. The origin may set these itself, which the zone configuration cannot show.',
        rootCause: 'No response header rule, managed transform or zone setting adds these headers.', intendedBehavior: 'Every HTML response carries a CSP with frame-ancestors (or X-Frame-Options) and X-Content-Type-Options: nosniff.',
        evidence: [ev(phasePath('http_response_headers_transform'), 'headers set', [...set].join(', ') || '(none)'), ev('GET /zones/{id}/managed_headers', 'add_security_headers', managed?.enabled ?? false)],
        fix: ['Rules › Transform Rules › Managed Transforms: turn on "Add security headers" (X-Frame-Options, X-Content-Type-Options, Referrer-Policy …).', 'For a CSP, add a response header transform rule setting Content-Security-Policy (start in Report-Only).'],
        validation: `Run \`curl -sI https://${c.s.zoneName}/\` and the main application pages: if the origin already sends ${missing.join(', ')}, this is settled.` }];
    },
  },
  {
    id: 'client.page_shield', title: 'Page Shield (client-side script monitoring)', group: 'client', attackClass: 'DOM-based XSS (third-party and injected scripts)', skillRef: CLIENT,
    needs: ['page_shield'], passed: 'Page Shield is on.',
    check: (c) => c.v<{ enabled?: boolean }>('page_shield')?.enabled ? [] : [{ verdict: 'confirmed', severity: 'low', title: 'Page Shield is off',
      description: 'Nobody is told when a new or changed script (a compromised third-party library, a skimmer) starts running on the zone\'s pages.', rootCause: 'Page Shield is disabled.',
      intendedBehavior: 'Script monitoring on, with alerts for new scripts.', evidence: [ev('GET /zones/{id}/page_shield', 'enabled', false)], fix: ['Security › Page Shield (client-side security): turn on, and add a notification for new scripts.'] }],
  },
];

// ── Edge runtime boundary ───────────────────────────────────────────────────

const EDGE: RuleDef[] = [
  {
    id: 'edge.worker_routes', title: 'Worker routes', group: 'edge', attackClass: 'Edge/runtime boundary mismatch', skillRef: CLOUD,
    needs: ['worker_routes'], passed: 'No Worker routes on the zone.',
    check: (c) => {
      const routes = c.v<WorkerRoute[]>('worker_routes') ?? [];
      if (!routes.length) return [];
      const src = 'GET /zones/{id}/workers/routes';
      const out: Draft[] = [{ resource: 'list', verdict: 'needs_validation', severity: 'info', title: `${plural(routes.length, 'Worker route')} on the zone`,
        description: 'Code runs at the edge for these patterns, before (or instead of) the origin. Where a Worker enforces authentication, its behaviour on errors and on unmatched paths decides what the origin receives.',
        rootCause: 'Worker routes are configured.', intendedBehavior: 'Each Worker fails closed and every path that needs it is covered.', evidence: routes.slice(0, 20).map((r) => ev(src, r.pattern, r.script || '(no Worker: requests skip Workers)')),
        fix: ['Review each route in Workers Routes; none is changed by the audit.'], validation: 'For each Worker that enforces access, check its error path (an exception or upstream failure) returns an error, not a pass-through to the origin.' }];
      const scripts = routes.filter((r) => r.script);
      for (const r of routes) {
        const sens = sensitivePaths(r.pattern);
        if (!r.script && sens.length && scripts.some((s) => isBroadPattern(s.pattern))) out.push({ resource: r.id, verdict: 'needs_validation', severity: 'medium', title: `Requests to ${r.pattern} skip the Worker that covers the rest of the zone`,
          description: `This route has no Worker, so ${sens.join(', ')} goes straight to the origin while broader patterns run a Worker. If that Worker is where authentication or input checks happen, these paths bypass them.`,
          rootCause: 'A Worker-less route on a sensitive path under a broader Worker route.', intendedBehavior: 'Paths that need the Worker\'s checks are not excluded from it.', evidence: [ev(src, r.pattern, '(no Worker)'), ...scripts.filter((s) => isBroadPattern(s.pattern)).slice(0, 3).map((s) => ev(src, s.pattern, s.script ?? ''))],
          fix: ['Workers Routes: remove the exclusion, or make sure the origin enforces the same checks for these paths.'], validation: 'Read the Worker on the broad route: if it does authentication or validation, request the excluded path directly and confirm the origin enforces the same.' });
        else if (r.script && sens.length) out.push({ resource: r.id, verdict: 'needs_validation', severity: 'low', title: `Worker ${r.script} handles ${r.pattern}`,
          description: `The Worker runs on ${sens.join(', ')}. If it calls the origin with its own credentials or skips checks on error, the edge and origin disagree about who is allowed.`,
          rootCause: 'A Worker on a sensitive path.', intendedBehavior: 'The Worker passes the caller\'s identity through and fails closed.', evidence: [ev(src, r.pattern, r.script)],
          fix: ['No change unless the review finds a fail-open path.'], validation: `Review ${r.script}: what it does on exceptions and timeouts, and which credentials it uses towards the origin.` });
      }
      return out;
    },
  },
];

export const RULES: RuleDef[] = [...TRANSPORT, ...ORIGIN, ...EMAIL, ...WAF, ...AVAILABILITY, ...CACHE, ...HOST, ...CLIENT_RULES, ...EDGE];

// ── Engine ──────────────────────────────────────────────────────────────────

/** Runs every rule over the snapshot: findings worst first, and one coverage entry per rule (in RULES order). */
export function runRules(s: Snapshot, rules: RuleDef[] = RULES): { findings: AuditFinding[]; coverage: CoverageEntry[] } {
  const zr = s.reads.zone;
  const zone = zr?.state === 'ok' ? zr.value as ZoneInfo : null;
  const value = <T>(k: SourceKey) => { const g = s.reads[k]; return (g?.state === 'ok' ? g.value : undefined) as T; };
  const ctx: Ctx = { s, zone, v: value, opt: value };
  const findings: AuditFinding[] = [];
  const coverage: CoverageEntry[] = [];
  for (const def of rules) {
    const base = { ruleId: def.id, title: def.title, group: def.group, attackClass: def.attackClass, skillRef: def.skillRef };
    const failed = def.needs.map((k) => ({ k, g: s.reads[k] })).find((x) => !x.g || x.g.state === 'error');
    if (failed) {
      const g = failed.g;
      coverage.push({ ...base, state: 'not_read', findings: 0, reason: `${SOURCES[failed.k].label} could not be read: ${g?.state === 'error' ? g.reason : 'not read'}`, permission: SOURCES[failed.k].permission });
      continue;
    }
    const absent = def.needs.map((k) => ({ k, g: s.reads[k]! })).find((x) => x.g.state === 'absent');
    if (absent) { coverage.push({ ...base, state: 'not_applicable', findings: 0, reason: `${SOURCES[absent.k].label}: ${(absent.g as { reason: string }).reason}` }); continue; }
    if (def.plans && zone && !def.plans.includes(zone.plan)) { coverage.push({ ...base, state: 'not_applicable', findings: 0, reason: `Not offered on the ${zone.plan} plan` }); continue; }
    if (def.authoritativeDns && zone?.type === 'partial') { coverage.push({ ...base, state: 'not_applicable', findings: 0, reason: 'Partial (CNAME) setup: the zone\'s authoritative DNS is hosted elsewhere' }); continue; }
    const out = def.check(ctx);
    if (!Array.isArray(out)) { coverage.push({ ...base, state: 'not_applicable', findings: 0, reason: out.notApplicable }); continue; }
    for (const d of out) findings.push(toFinding(s.zoneId, def, d));
    coverage.push({ ...base, state: out.length ? 'finding' : 'passed', findings: out.length, ...(out.length ? {} : { reason: def.passed }) });
  }
  return { findings: findings.sort(byWorst), coverage };
}

export function toFinding(zoneId: string, def: Pick<RuleDef, 'id' | 'group' | 'attackClass' | 'skillRef'>, d: Draft): AuditFinding {
  return {
    fingerprint: `zone:${zoneId}:${def.id}${d.resource ? `:${d.resource}` : ''}`, ruleId: def.id, group: def.group, verdict: d.verdict, severity: d.severity,
    attackClass: def.attackClass, skillRef: def.skillRef, title: d.title, description: d.description, rootCause: d.rootCause, intendedBehavior: d.intendedBehavior,
    evidence: d.evidence, fix: d.fix, validation: d.verdict === 'needs_validation' ? d.validation ?? 'Check the condition described above against the live site.' : null,
  };
}

/** Counts per severity, verdict and coverage state, and the worst severity. */
export function summarize(findings: AuditFinding[], coverage: CoverageEntry[], calls = 0, lookups = 0): AuditSummary {
  const s = emptySummary();
  for (const f of findings) { s.bySeverity[f.severity]++; s.byVerdict[f.verdict]++; if (!s.worst || SEVERITY_RANK[f.severity] > SEVERITY_RANK[s.worst]) s.worst = f.severity; }
  for (const c of coverage) s.coverage[c.state]++;
  s.rules = coverage.length;
  s.calls = calls;
  s.lookups = lookups;
  return s;
}
