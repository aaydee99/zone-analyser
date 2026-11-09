import type { LeakedConfig, LeakedFinding, LeakedTraffic } from './investigate-types';

// Leaked credentials: what Cloudflare's check results mean, which rule fields act on them, and the
// conclusions drawn from a zone's configuration and traffic, each with the numbers behind it.
// Pure (no reads): the page and the tests use it too.

/** Rule fields, from developers.cloudflare.com/waf/detections/leaked-credentials/ (with the plan each needs). */
export const CREDENTIAL_FIELDS: Record<string, { label: string; plan: string }> = {
  'cf.waf.credential_check.password_leaked': { label: 'Password leaked', plan: 'All plans' },
  'cf.waf.credential_check.username_and_password_leaked': { label: 'Username and password leaked (pair)', plan: 'Pro and above' },
  'cf.waf.credential_check.username_leaked': { label: 'Username leaked', plan: 'Enterprise' },
  'cf.waf.credential_check.username_password_similar': { label: 'Similar username and password leaked', plan: 'Enterprise' },
  'cf.waf.auth_detected': { label: 'Authentication request detected', plan: 'Enterprise' },
};
const FIELD_RE = /cf\.waf\.(?:credential_check\.[a-z_]+|auth_detected)/g;

/** The credential fields an expression uses, in order of first use. */
export function credentialFields(expression: string): string[] {
  return [...new Set(expression.match(FIELD_RE) ?? [])];
}

/** A result value as Cloudflare's analytics gives it, normalised (lower case, words joined by _). */
const norm = (v: string) => v.trim().toLowerCase().replace(/[\s-]+/g, '_');
const NOT_LEAKED = new Set(['', 'clean', 'none', 'not_checked', 'notchecked', 'unknown', 'no_leak', 'not_leaked']);

/** Whether a result value says a credential leaked. */
export const isLeaked = (v: string) => !NOT_LEAKED.has(norm(v));
const UNCHECKED = new Set(['', 'none', 'not_checked', 'notchecked', 'unknown']);
/** Whether the request was checked at all (it carried credentials at a location Cloudflare looks at). */
export const isChecked = (v: string) => !UNCHECKED.has(norm(v));

const RESULT: Record<string, { label: string; tone: 'bad' | 'warn' | 'neutral' | 'ok' }> = {
  username_and_password_leaked: { label: 'Username and password leaked (pair)', tone: 'bad' },
  password_leaked: { label: 'Password leaked', tone: 'warn' },
  username_password_similar: { label: 'Similar username and password leaked', tone: 'warn' },
  username_leaked: { label: 'Username leaked', tone: 'neutral' },
  clean: { label: 'Checked: nothing leaked', tone: 'ok' },
  '': { label: 'Not checked (no credentials found)', tone: 'neutral' },
};
/** A result value in words, and its tone. Unknown values are shown as Cloudflare gives them. */
export function resultOf(v: string): { label: string; tone: 'bad' | 'warn' | 'neutral' | 'ok' } {
  return RESULT[norm(v)] ?? { label: v || 'Not checked', tone: isLeaked(v) ? 'warn' : 'neutral' };
}

/** Security actions that stopped or challenged a request (the rest let it through to the origin). */
const STOPPING = /block|challenge|deny|drop|ban|captcha/i;
export const stops = (action: string) => STOPPING.test(action);
/** A response the origin (or the edge) answered successfully: a login that may have worked. */
export const answeredOk = (status: number) => status >= 200 && status < 400;

const n = (x: number) => x.toLocaleString('en-US');
const pct = (x: number, of: number) => (of ? `${(Math.round((x / of) * 1000) / 10).toFixed(1)}%` : '0%');

/** What a zone's leaked-credential setup and traffic show, the most serious first. */
export function leakedFindings(c: LeakedConfig | null, t: LeakedTraffic | null): LeakedFinding[] {
  const out: LeakedFinding[] = [];
  const acting = (c?.rules ?? []).filter((r) => r.enabled && r.fields.some((f) => f.startsWith('cf.waf.credential_check')));
  const enforcing = acting.filter((r) => r.action !== 'log');

  if (c?.enabled === false) {
    out.push({ key: 'off', tone: 'bad', title: 'Leaked credentials detection is off',
      detail: 'GET /zones/{id}/leaked-credential-checks answered enabled: false, so no login is checked against known leaked credentials and the cf.waf.credential_check.* fields are always false.',
      fix: ['Security › Settings › Detections: turn on Leaked credentials detection (or POST /zones/{id}/leaked-credential-checks {"enabled": true} with a Zone WAF Write token).', 'Then add a rule that acts on it (below).'] });
  }
  if (c?.enabled && !acting.length) {
    out.push({ key: 'no_rule', tone: 'warn', title: 'Detection is on but no enabled rule acts on it',
      detail: `Detection only marks requests; ${c.rules.length ? `the ${n(c.rules.length)} rule(s) using credential fields are all turned off` : 'no custom or rate limiting rule uses a cf.waf.credential_check.* field'}, so leaked-credential logins are let through.`,
      fix: ['Custom rule: (cf.waf.credential_check.username_and_password_leaked) → Managed Challenge (Cloudflare\'s recommendation on paid plans).', 'Or a rate limiting rule: same expression, 5 requests per minute per IP (the suggested template on Free plans).'] });
  }
  if (acting.length && !enforcing.length) {
    out.push({ key: 'log_only', tone: 'warn', title: 'Rules on leaked credentials only log',
      detail: `${n(acting.length)} enabled rule(s) use credential fields, all with action Log: matching logins still reach the origin.`,
      fix: ['After reviewing the logged events, change the action to Managed Challenge (or Block for API logins that cannot solve a challenge).'] });
  }
  if (!t) return out.length ? out : [{ key: 'none', tone: 'info', title: 'No traffic read', detail: 'The traffic part could not be read; only the configuration is shown.' }];

  const total = t.results.reduce((s, r) => s + r.count, 0);
  const checked = t.results.filter((r) => isChecked(r.result)).reduce((s, r) => s + r.count, 0);
  if (c?.enabled && !checked) {
    out.push({ key: 'nothing_checked', tone: 'info', title: 'No request was checked in the window',
      detail: `Of ${n(total)} requests, none carried credentials at a location Cloudflare checks (the defaults cover Drupal, Joomla, Ghost, Magento, Plone, WordPress, Exchange OWA and common login forms).`,
      fix: ['If the site has its own login, add a custom detection location (Enterprise): Security › Settings › Leaked credentials › Add detection location, with the username (and password) expression, e.g. lookup_json_string(http.request.body.raw, "email").'] });
  }
  if (t.leaked) {
    const okLeaked = t.byStatus.filter((r) => answeredOk(r.status)).reduce((s, r) => s + r.count, 0);
    const pairs = t.results.filter((r) => norm(r.result) === 'username_and_password_leaked').reduce((s, r) => s + r.count, 0);
    if (t.byAction) {
      const stopped = t.byAction.filter((r) => stops(r.action)).reduce((s, r) => s + r.count, 0);
      const through = t.leaked - stopped;
      out.push({ key: 'through', tone: through ? 'bad' : 'ok', title: through ? `${n(through)} leaked-credential requests reached the origin` : 'Every leaked-credential request was stopped or challenged',
        detail: `${n(t.leaked)} requests carried leaked credentials (${pct(t.leaked, checked)} of the ${n(checked)} checked); ${n(stopped)} (${pct(stopped, t.leaked)}) were blocked or challenged by security, ${n(through)} (${pct(through, t.leaked)}) were not.${pairs ? ` ${n(pairs)} of them were a leaked username and password pair.` : ''}`,
        ...(through ? { fix: ['Add or tighten a rule on cf.waf.credential_check.username_and_password_leaked (Managed Challenge), and force a password reset for the accounts concerned.'] } : {}) });
    } else {
      out.push({ key: 'leaked', tone: 'warn', title: `${n(t.leaked)} requests carried leaked credentials`,
        detail: `${pct(t.leaked, checked)} of the ${n(checked)} checked requests.${pairs ? ` ${n(pairs)} were a leaked username and password pair.` : ''} This plan's analytics do not say which security action applied to them.` });
    }
    if (okLeaked) {
      out.push({ key: 'answered_ok', tone: 'bad', title: `${n(okLeaked)} leaked-credential logins were answered 2xx/3xx`,
        detail: `${pct(okLeaked, t.leaked)} of the leaked-credential requests got a success or redirect status. On many sites a 200 or 302 after a login POST means the login worked: possible account takeover. (Some sites answer 200 to a failed login too; check the application's own log for these times and paths.)`,
        fix: ['Find the accounts in the application log for the paths and hours below, and force a password reset.', 'Challenge leaked-credential logins so this cannot repeat.'] });
    }
    const top = t.ips[0];
    const ipTotal = t.ips.reduce((s, r) => s + r.count, 0);
    if (top && ipTotal >= 20 && top.count / ipTotal >= 0.2) {
      out.push({ key: 'concentrated', tone: 'warn', title: 'Credential stuffing from few clients',
        detail: `${top.ip} (AS${top.asn} ${top.asnName}) sent ${n(top.count)} of ${n(ipTotal)} leaked-credential requests (${pct(top.count, ipTotal)}).`,
        fix: ['Rate limit the login path per IP (5 per minute, block 10 minutes), and challenge requests whose bot score is below 30.'] });
    }
  } else if (checked) {
    out.push({ key: 'clean', tone: 'ok', title: 'No leaked credentials seen', detail: `${n(checked)} requests were checked in the window; none carried leaked credentials.` });
  }
  const order = { bad: 0, warn: 1, info: 2, ok: 3 } as const;
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}
