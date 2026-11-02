// Page Rules → the rules that replace them, following Cloudflare's migration guide
// (developers.cloudflare.com/rules/reference/page-rules-migration). For each Page Rule setting:
// the rule type to create, the field to set there and its value, and the Page Rule's URL pattern as
// that rule's match (a filter expression, or a wildcard pattern for Single Redirects). Pure — shared
// by the Page Rules check and tests.

export type Product = 'Cache rule' | 'Configuration rule' | 'Single Redirect' | 'Origin rule' | 'Managed Transform' | 'Zone setting';

/** Where a setting goes; `none`: Cloudflare does not migrate it (a decision by hand). */
export interface Move { product: Product | null; set: string; none?: boolean; note?: string }

const PHASE: Record<Product, string> = {
  'Cache rule': 'Caching › Cache Rules (http_request_cache_settings)',
  'Configuration rule': 'Rules › Configuration Rules (http_config_settings)',
  'Single Redirect': 'Rules › Redirect Rules › Single Redirects (http_request_dynamic_redirect)',
  'Origin rule': 'Rules › Origin Rules (http_request_origin)',
  'Managed Transform': 'Rules › Transform Rules › Managed Transforms (zone-wide, no match)',
  'Zone setting': 'The zone setting',
};
export const whereToCreate = (p: Product) => PHASE[p];

const v = (x: unknown) => (x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
const onOff = (x: unknown) => (v(x) === 'off' ? 'Off' : 'On');
/** Seconds as the dashboard offers them ("2 hours"). */
export function ttl(x: unknown): string {
  const s = Number(x);
  if (!Number.isFinite(s) || s <= 0) return v(x);
  const units: [number, string][] = [[31_536_000, 'year'], [2_592_000, 'month'], [86_400, 'day'], [3_600, 'hour'], [60, 'minute'], [1, 'second']];
  const [n, u] = units.find(([d]) => s % d === 0)!;
  return `${s / n} ${u}${s / n === 1 ? '' : 's'}`;
}

const SECURITY_LEVEL: Record<string, string> = { essentially_off: 'Essentially Off', low: 'Low', medium: 'Medium', high: 'High', under_attack: 'I’m Under Attack', off: 'Off' };
const SSL: Record<string, string> = { off: 'Off', flexible: 'Flexible', full: 'Full', strict: 'Strict', origin_pull: 'Strict (SSL-Only Origin Pull)' };
const MIGRATE_DEPRECATED = 'Cloudflare does not migrate it automatically';

/** Where one Page Rule setting goes, with the value it had. */
export function moveOf(id: string, value: unknown): Move {
  switch (id) {
    case 'forwarding_url': return { product: 'Single Redirect', set: 'Target URL and status code (see the match)' };
    case 'always_use_https': return { product: 'Single Redirect', set: 'Template “Redirect from HTTP to HTTPS”: Request URL http://*, Target URL https://${1}, Status code 301, Preserve query string On' };
    case 'cache_level': {
      const l = v(value);
      if (l === 'bypass') return { product: 'Cache rule', set: 'Cache eligibility: Bypass cache' };
      if (l === 'cache_everything') return { product: 'Cache rule', set: 'Cache eligibility: Eligible for cache (caches everything, as Cache Everything did)' };
      if (l === 'simplified') return { product: 'Cache rule', set: 'Cache eligibility: Eligible for cache · Cache key › Query string: Ignore query string' };
      if (l === 'basic') return { product: 'Cache rule', set: 'No query string: no single field — a Cache rule that bypasses cache when http.request.uri.query ne ""', note: 'Not in the migration guide: check the result' };
      return { product: 'Cache rule', set: 'Standard cache level is the default: nothing to set (or Cache eligibility: Eligible for cache)' };
    }
    case 'edge_cache_ttl': return { product: 'Cache rule', set: `Cache eligibility: Eligible for cache · Edge TTL: Ignore cache-control header and use this TTL · ${ttl(value)}` };
    case 'browser_cache_ttl': return { product: 'Cache rule', set: `Cache eligibility: Eligible for cache · Browser TTL: Override origin and use this TTL · ${ttl(value)}` };
    case 'cache_key_fields': return { product: 'Cache rule', set: 'Cache eligibility: Eligible for cache · Cache key: the same query string, headers, cookies, host and user fields', note: v(value) };
    case 'cache_deception_armor': return { product: 'Cache rule', set: `Cache key › Cache deception armor: ${onOff(value)}` };
    case 'cache_by_device_type': return { product: 'Cache rule', set: `Cache key › Cache by device type: ${onOff(value)}` };
    case 'sort_query_string_for_cache': return { product: 'Cache rule', set: `Cache key › Sort query string: ${onOff(value)}` };
    case 'cache_on_cookie': return { product: 'Cache rule', set: `Cache eligibility: Eligible for cache, with the match also requiring the cookie: http.cookie matches "${v(value)}"` };
    case 'bypass_cache_on_cookie': return { product: 'Cache rule', set: `Cache eligibility: Bypass cache, with the match also requiring the cookie: http.cookie matches "${v(value)}"` };
    case 'cache_ttl_by_status': {
      const codes = value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>).map(([c, t]) => `${c}: ${t === 'no-cache' || t === 'no-store' ? t : ttl(t)}`).join(', ') : v(value);
      return { product: 'Cache rule', set: `Cache eligibility: Eligible for cache · Edge TTL › Status code TTL: ${codes}` };
    }
    case 'origin_cache_control': return { product: 'Cache rule', set: `Origin Cache Control: ${onOff(value)}` };
    case 'explicit_cache_control': return { product: 'Cache rule', set: `Origin Cache Control: ${onOff(value)}`, note: 'Not in the migration guide: check the result' };
    case 'origin_error_page_pass_thru': return { product: 'Cache rule', set: `Origin error page pass-thru: ${onOff(value)}` };
    case 'respect_strong_etag': return { product: 'Cache rule', set: `Respect strong ETags: ${onOff(value)}` };
    case 'ssl': return { product: 'Configuration rule', set: `SSL: ${SSL[v(value)] ?? v(value)}` };
    case 'security_level': return { product: 'Configuration rule', set: v(value) === 'under_attack' ? 'I’m Under Attack: On' : `Security Level: ${SECURITY_LEVEL[v(value)] ?? v(value)}` };
    case 'automatic_https_rewrites': return { product: 'Configuration rule', set: `Automatic HTTPS Rewrites: ${onOff(value)}` };
    case 'browser_check': case 'bic': return { product: 'Configuration rule', set: `Browser Integrity Check: ${onOff(value)}` };
    case 'email_obfuscation': return { product: 'Configuration rule', set: `Email Obfuscation: ${onOff(value)}` };
    case 'opportunistic_encryption': return { product: 'Configuration rule', set: `Opportunistic Encryption: ${onOff(value)}` };
    case 'rocket_loader': return { product: 'Configuration rule', set: `Rocket Loader: ${onOff(value)}` };
    case 'polish': return { product: 'Configuration rule', set: `Polish: ${v(value) === 'off' ? 'Off' : v(value) === 'lossy' ? 'Lossy' : 'Lossless'}` };
    case 'hotlink_protection': return { product: 'Configuration rule', set: `Hotlink Protection: ${onOff(value)}` };
    case 'server_side_exclude': return { product: 'Configuration rule', set: `Server Side Excludes: ${onOff(value)}`, note: 'Not in the migration guide: check the result' };
    case 'mirage': return { product: 'Configuration rule', set: `Mirage: ${onOff(value)}`, note: 'Not in the migration guide; Mirage is deprecated by Cloudflare' };
    case 'automatic_platform_optimization': return { product: 'Configuration rule', set: `Automatic Platform Optimization: ${onOff(value)}`, note: 'Not in the migration guide: check the result' };
    case 'minify': return { product: null, set: 'Auto Minify is retired by Cloudflare: nothing to recreate', none: true };
    case 'disable_apps': return { product: 'Configuration rule', set: 'Disable Apps' };
    case 'disable_zaraz': return { product: 'Configuration rule', set: 'Disable Zaraz' };
    case 'host_header_override': return { product: 'Origin rule', set: `Host Header › Rewrite to: ${v(value)}` };
    case 'resolve_override': return { product: 'Origin rule', set: `DNS Record › Override to: ${v(value)}` };
    case 'true_client_ip_header': return { product: 'Managed Transform', set: 'Add “True-Client-IP” header', note: 'Applies to the whole zone, not just this URL' };
    case 'ip_geolocation': return { product: 'Managed Transform', set: 'Add visitor location headers', note: 'Applies to the whole zone, not just this URL' };
    case 'disable_performance': return { product: 'Configuration rule', set: 'Polish: Off · Rocket Loader: Off', none: true, note: `Deprecated; ${MIGRATE_DEPRECATED}` };
    case 'disable_security': return { product: 'Configuration rule', set: 'Email Obfuscation: Off · Hotlink Protection: Off, and a WAF exception (skip) for what must not be checked', none: true, note: `Deprecated; ${MIGRATE_DEPRECATED}` };
    case 'disable_railgun': return { product: null, set: 'Railgun is retired: nothing to recreate', none: true };
    case 'response_buffering': return { product: null, set: 'No replacement', none: true, note: `Deprecated; ${MIGRATE_DEPRECATED}` };
    case 'waf': return { product: null, set: 'No replacement: use WAF custom rules or exceptions', none: true, note: `Deprecated; ${MIGRATE_DEPRECATED}` };
    default: return { product: null, set: 'Not in the migration guide: check it by hand', none: true };
  }
}

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const hasScheme = (url: string) => /^https?:\/\//i.test(url) || /^\*:\/\//.test(url);

/**
 * A Page Rule URL pattern as a filter expression: Page Rules ignore the scheme and the query string
 * unless the pattern names them, http.request.full_uri has both — so "http*://" in front and "*" at
 * the end (example.com/*\/downloads/*.txt → http.request.full_uri wildcard "http*://example.com/*\/downloads/*.txt*").
 */
export function matchExpression(url: string): string {
  const u = url.trim();
  if (!u) return 'true';
  const full = `${hasScheme(u) ? u : `http*://${u}`}${u.endsWith('*') ? '' : '*'}`;
  return `http.request.full_uri wildcard ${quote(full)}`;
}

/** A Forwarding URL as a Single Redirect: its wildcard request URL, target (with ${n} for each *) and status. */
export function redirectOf(url: string, value: unknown): { request: string; target: string; status: number } {
  const f = (value && typeof value === 'object' ? value : {}) as { url?: string; status_code?: number };
  const prefixed = !hasScheme(url.trim());
  // "http*://" adds a wildcard in front: every $n of the target moves one on.
  const target = (f.url ?? '').replace(/\$(\d+)/g, (_, n: string) => `\${${Number(n) + (prefixed ? 1 : 0)}}`);
  return { request: prefixed ? `http*://${url.trim()}` : url.trim(), target, status: Number(f.status_code) || 301 };
}

export interface PageRuleLike { id: string; status?: string; priority?: number; targets?: { constraint?: { value?: string } }[]; actions?: { id: string; value?: unknown }[] }

/** One rule to create for a Page Rule: the product, where, its match and every field to set. */
export interface PlannedRule { product: Product; where: string; match: string; set: string[]; notes: string[] }

/** What a Page Rule becomes: one rule per product its settings go to, and the settings with nowhere to go. */
export function planPageRule(r: PageRuleLike): { url: string; rules: PlannedRule[]; manual: { setting: string; what: string }[]; verdict: 'Yes' | 'Partly' | 'No' } {
  const url = r.targets?.[0]?.constraint?.value ?? '';
  const by = new Map<Product, PlannedRule>();
  const manual: { setting: string; what: string }[] = [];
  for (const a of r.actions ?? []) {
    const m = moveOf(a.id, a.value);
    if (m.none) manual.push({ setting: a.id, what: [m.set, m.note].filter(Boolean).join(' — ') });
    if (!m.product || (m.none && m.product !== 'Configuration rule')) continue;
    let match = m.product === 'Managed Transform' ? '(zone-wide)' : matchExpression(url);
    let set = m.set;
    if (a.id === 'forwarding_url') {
      const d = redirectOf(url, a.value);
      match = `Wildcard pattern › Request URL: ${d.request}`;
      set = `Target URL: ${d.target} · Status code: ${d.status} · Preserve query string: On`;
    } else if (a.id === 'always_use_https') match = 'Wildcard pattern › Request URL: http://*';
    const key = a.id === 'forwarding_url' || a.id === 'always_use_https' ? 'Single Redirect' : m.product;
    const p = by.get(key) ?? { product: m.product, where: whereToCreate(m.product), match, set: [], notes: [] };
    p.set.push(set);
    if (m.note && !m.none) p.notes.push(`${a.id}: ${m.note}`);
    if (m.none) p.notes.push(`${a.id}: replaces a deprecated setting (not migrated by Cloudflare)`);
    by.set(key, p);
  }
  const rules = [...by.values()];
  const verdict = !manual.length ? 'Yes' : rules.length ? 'Partly' : 'No';
  return { url, rules, manual, verdict };
}
