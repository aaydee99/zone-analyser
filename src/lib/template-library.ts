// Best-practice template items: zone settings, managed rules and OWASP tuning, custom rules, rate
// limiting, cache rules and security headers, each with why it matters. Ticked in the template page and
// checked against every zone's stored configuration (nothing is written to Cloudflare). Values are in
// the form the search index keeps them (zone-index.ts): a setting's value as text, a rule's fields by
// their path in the rule. Pure: shared by the page and the tests.

import type { CheckWhen, IndexKind, TemplateItem, TemplateMatch } from './zone-index';

export interface LibraryEntry { id: string; group: LibraryGroup; title: string; why: string; item: TemplateItem }
export type LibraryGroup = 'SSL/TLS' | 'Security settings' | 'Performance and CDN' | 'Managed rules and OWASP' | 'Custom rules' | 'Rate limiting' | 'Cache rules' | 'Security headers';
export const LIBRARY_GROUPS: LibraryGroup[] = ['SSL/TLS', 'Security settings', 'Performance and CDN', 'Managed rules and OWASP', 'Custom rules', 'Rate limiting', 'Cache rules', 'Security headers'];

export const CF_MANAGED_ID = 'efb7b8c949ac4650a09736fc376e9aee';
export const OWASP_ID = '4814384a9e5d4991b9815dcfc25d2f1f';

/** Ruleset phases a rule check can look at, with how the dashboard names them. */
export const PHASES: { phase: string; label: string; kind: IndexKind }[] = [
  { phase: 'http_request_firewall_custom', label: 'Custom rules (WAF)', kind: 'rule' },
  { phase: 'http_ratelimit', label: 'Rate limiting rules', kind: 'rule' },
  { phase: 'http_request_firewall_managed', label: 'Managed rules (deployments and exceptions)', kind: 'rule' },
  { phase: 'http_request_cache_settings', label: 'Cache rules', kind: 'rule' },
  { phase: 'http_config_settings', label: 'Configuration rules', kind: 'rule' },
  { phase: 'http_request_origin', label: 'Origin rules', kind: 'rule' },
  { phase: 'http_request_dynamic_redirect', label: 'Single redirects', kind: 'redirect' },
  { phase: 'http_request_redirect', label: 'Bulk redirects', kind: 'redirect' },
  { phase: 'http_request_transform', label: 'URL rewrite rules', kind: 'rule' },
  { phase: 'http_request_late_transform', label: 'Request header transform rules', kind: 'header' },
  { phase: 'http_response_headers_transform', label: 'Response header transform rules', kind: 'header' },
  { phase: 'http_response_compression', label: 'Compression rules', kind: 'rule' },
  { phase: 'http_custom_errors', label: 'Custom error rules', kind: 'rule' },
  { phase: 'http_request_sbfm', label: 'Super Bot Fight Mode rules', kind: 'rule' },
  { phase: 'ddos_l7', label: 'HTTP DDoS overrides', kind: 'rule' },
  { phase: 'http_response_firewall_managed', label: 'Response managed rules (sensitive data)', kind: 'rule' },
  { phase: 'http_log_custom_fields', label: 'Logpush custom fields', kind: 'rule' },
];
export const PHASE_LABEL: Record<string, string> = Object.fromEntries(PHASES.map((p) => [p.phase, p.label]));

/** Fields of a rule worth checking, as suggestions in the form ([*] stands for any list position). */
export const RULE_FIELDS = [
  'description', 'expression', 'action', 'enabled',
  'action_parameters.id', 'action_parameters.ruleset', 'action_parameters.phases', 'action_parameters.products',
  'action_parameters.overrides.action', 'action_parameters.overrides.enabled', 'action_parameters.overrides.rules[*].id', 'action_parameters.overrides.rules[*].action',
  'action_parameters.overrides.rules[*].score_threshold', 'action_parameters.overrides.rules[*].enabled', 'action_parameters.overrides.categories[*].category', 'action_parameters.overrides.categories[*].enabled',
  'action_parameters.overrides.sensitivity_level',
  'ratelimit.characteristics', 'ratelimit.period', 'ratelimit.requests_per_period', 'ratelimit.mitigation_timeout', 'ratelimit.counting_expression',
  'action_parameters.cache', 'action_parameters.edge_ttl.mode', 'action_parameters.edge_ttl.default', 'action_parameters.browser_ttl.mode', 'action_parameters.cache_key.cache_deception_armor',
  'action_parameters.headers.<Header-Name>.operation', 'action_parameters.headers.<Header-Name>.value',
  'action_parameters.from_value.status_code', 'action_parameters.from_value.target_url.value',
  'action_parameters.ssl', 'action_parameters.security_level', 'action_parameters.automatic_https_rewrites',
];

/** Zone setting IDs (as Cloudflare names them), as suggestions in the form. */
export const SETTING_IDS = [
  'ssl', 'min_tls_version', 'tls_1_3', 'always_use_https', 'automatic_https_rewrites', 'opportunistic_encryption', 'security_header', 'tls_client_auth', 'ciphers',
  'security_level', 'browser_check', 'challenge_ttl', 'email_obfuscation', 'server_side_exclude', 'hotlink_protection', 'ip_geolocation', 'privacy_pass', 'waf',
  'cache_level', 'browser_cache_ttl', 'always_online', 'development_mode', 'early_hints', 'http2', 'http3', '0rtt', 'brotli', 'rocket_loader', 'polish', 'webp', 'mirage', 'image_resizing',
  'ipv6', 'websockets', 'pseudo_ipv4', 'true_client_ip_header', 'origin_error_page_pass_thru', 'sort_query_string_for_cache', 'response_buffering', 'max_upload', 'dnssec',
];

const setting = (id: string, match: TemplateMatch, expected: string, path?: string): TemplateItem => ({ item: `setting:${id}`, kind: 'setting', path: path ?? `Setting ${id}`, expected, match });
const check = (phase: string, key: string, path: string, when: CheckWhen[], match: 'present' | 'absent' = 'present'): TemplateItem => ({
  item: `check:${phase}:${key}`, kind: PHASES.find((p) => p.phase === phase)?.kind ?? 'rule', path, expected: '', match, check: { phase, when },
});
const w = (field: string, match: CheckWhen['match'], value: string): CheckWhen => ({ field, match, value });

/** The console's own baseline checks (the first library; most are now covered by Cloudflare's docs list below). */
export const LIBRARY: LibraryEntry[] = [
  // ── SSL/TLS ──
  { id: 'ssl-strict', group: 'SSL/TLS', title: 'SSL/TLS mode is Full (strict)', why: 'Cloudflare checks the origin certificate; Flexible or Full leave the origin leg open to interception.', item: setting('ssl', 'equals', 'strict', 'SSL/TLS encryption mode') },
  { id: 'min-tls', group: 'SSL/TLS', title: 'Minimum TLS version is 1.2 or higher', why: 'TLS 1.0 and 1.1 are deprecated and fail PCI DSS.', item: setting('min_tls_version', 'at_least', '1.2', 'Minimum TLS version') },
  { id: 'tls13', group: 'SSL/TLS', title: 'TLS 1.3 is on', why: 'Faster handshakes and only modern ciphers.', item: setting('tls_1_3', 'one_of', 'on, zrt', 'TLS 1.3') },
  { id: 'always-https', group: 'SSL/TLS', title: 'Always Use HTTPS is on', why: 'Every http:// request is redirected to https://.', item: setting('always_use_https', 'equals', 'on', 'Always Use HTTPS') },
  { id: 'https-rewrites', group: 'SSL/TLS', title: 'Automatic HTTPS Rewrites is on', why: 'Fixes mixed content by rewriting http:// links that have an https:// version.', item: setting('automatic_https_rewrites', 'equals', 'on', 'Automatic HTTPS Rewrites') },
  { id: 'hsts', group: 'SSL/TLS', title: 'HSTS is on', why: 'Browsers refuse plain HTTP to the site after their first visit.', item: setting('security_header', 'contains', '"enabled":true', 'HSTS (security_header)') },
  // ── Security settings ──
  { id: 'browser-check', group: 'Security settings', title: 'Browser Integrity Check is on', why: 'Stops requests with missing or forged browser headers, common in simple bots.', item: setting('browser_check', 'equals', 'on', 'Browser Integrity Check') },
  { id: 'email-obfuscation', group: 'Security settings', title: 'Email Address Obfuscation is on', why: 'Hides email addresses on pages from scrapers.', item: setting('email_obfuscation', 'equals', 'on', 'Email Address Obfuscation') },
  { id: 'not-under-attack', group: 'Security settings', title: 'Security Level is not left on “I’m Under Attack”', why: 'Under Attack challenges every visitor; it is for emergencies only.', item: setting('security_level', 'not_equals', 'under_attack', 'Security Level') },
  { id: 'dev-mode-off', group: 'Security settings', title: 'Development Mode is off', why: 'Development Mode bypasses the cache; left on, the origin takes all the traffic.', item: setting('development_mode', 'equals', 'off', 'Development Mode') },
  { id: 'dnssec', group: 'Security settings', title: 'DNSSEC is active', why: 'Signed DNS answers stop resolvers being given forged records.', item: setting('dnssec', 'contains', 'active', 'DNSSEC') },
  // ── Performance and CDN ──
  { id: 'http3', group: 'Performance and CDN', title: 'HTTP/3 (QUIC) is on', why: 'Faster connections, especially on mobile networks.', item: setting('http3', 'equals', 'on', 'HTTP/3') },
  { id: 'early-hints', group: 'Performance and CDN', title: 'Early Hints is on', why: 'Browsers start loading assets while the origin is still building the page.', item: setting('early_hints', 'equals', 'on', 'Early Hints') },
  { id: 'always-online', group: 'Performance and CDN', title: 'Always Online is on', why: 'Visitors get a cached copy of pages when the origin is down.', item: setting('always_online', 'equals', 'on', 'Always Online') },
  { id: 'cache-level', group: 'Performance and CDN', title: 'Caching level is Standard', why: 'Query strings are part of the cache key, so different content is never mixed up.', item: setting('cache_level', 'equals', 'aggressive', 'Caching level (Standard)') },
  // ── Managed rules and OWASP ──
  { id: 'cf-managed', group: 'Managed rules and OWASP', title: 'Cloudflare Managed Ruleset is deployed', why: 'Cloudflare’s own rules for known vulnerabilities and zero-days (Log4j, CVEs).',
    item: check('http_request_firewall_managed', 'cf_managed', 'Cloudflare Managed Ruleset deployed', [w('action', 'equals', 'execute'), w('action_parameters.id', 'equals', CF_MANAGED_ID)]) },
  { id: 'owasp', group: 'Managed rules and OWASP', title: 'OWASP Core Ruleset is deployed', why: 'Scores requests for SQL injection, XSS and other generic attacks.',
    item: check('http_request_firewall_managed', 'owasp', 'OWASP Core Ruleset deployed', [w('action', 'equals', 'execute'), w('action_parameters.id', 'equals', OWASP_ID)]) },
  { id: 'owasp-threshold', group: 'Managed rules and OWASP', title: 'OWASP anomaly score threshold is Medium (40) or stricter', why: 'Set explicitly: 60 (Low) lets most single-rule attacks through. 40 is Medium, 25 High.',
    item: check('http_request_firewall_managed', 'owasp_threshold', 'OWASP anomaly score threshold', [w('action_parameters.id', 'equals', OWASP_ID), w('action_parameters.overrides.rules[*].score_threshold', 'at_most', '40')]) },
  { id: 'owasp-action', group: 'Managed rules and OWASP', title: 'OWASP acts (Block or Managed challenge), not Log', why: 'An OWASP deployment that only logs protects nothing.',
    item: check('http_request_firewall_managed', 'owasp_action', 'OWASP action', [w('action_parameters.id', 'equals', OWASP_ID), w('action_parameters.overrides.rules[*].action', 'one_of', 'block, managed_challenge')]) },
  { id: 'cf-managed-not-log', group: 'Managed rules and OWASP', title: 'Cloudflare Managed Ruleset is not overridden to Log', why: 'An override of every rule to Log turns the ruleset off in practice.',
    item: check('http_request_firewall_managed', 'cf_managed_log', 'Cloudflare Managed Ruleset overridden to Log', [w('action_parameters.id', 'equals', CF_MANAGED_ID), w('action_parameters.overrides.action', 'equals', 'log')], 'absent') },
  { id: 'no-skip-all-managed', group: 'Managed rules and OWASP', title: 'No managed-rule exception skips every request', why: 'An exception with expression “true” turns the managed rules off for the whole zone.',
    item: check('http_request_firewall_managed', 'skip_all', 'Managed rule exception for every request', [w('action', 'equals', 'skip'), w('expression', 'equals', 'true')], 'absent') },
  // ── Custom rules ──
  { id: 'bot-score-rule', group: 'Custom rules', title: 'A custom rule challenges or blocks low bot scores', why: 'With Bot Management, challenge requests scored as likely automated (bot score under 30) that are not verified bots.',
    item: check('http_request_firewall_custom', 'bot_score', 'Custom rule on bot score', [w('expression', 'contains', 'cf.bot_management.score'), w('action', 'one_of', 'block, managed_challenge, challenge, js_challenge')]) },
  { id: 'admin-protect', group: 'Custom rules', title: 'Admin paths are protected by a custom rule', why: 'Change “/admin” to your admin path (/wp-admin, /administrator …): challenge or block it outside your own addresses.',
    item: check('http_request_firewall_custom', 'admin', 'Custom rule protecting /admin', [w('expression', 'contains', '/admin'), w('action', 'one_of', 'block, managed_challenge, challenge')]) },
  { id: 'no-skip-all-custom', group: 'Custom rules', title: 'No custom rule skips security for every request', why: 'A skip rule with expression “true” bypasses the WAF for the whole zone.',
    item: check('http_request_firewall_custom', 'skip_all', 'Custom rule skipping every request', [w('action', 'equals', 'skip'), w('expression', 'equals', 'true')], 'absent') },
  // ── Rate limiting ──
  { id: 'rl-login', group: 'Rate limiting', title: 'Login is rate limited (and acts)', why: 'Stops credential stuffing and password guessing. Change “/login” to your login path.',
    item: check('http_ratelimit', 'login', 'Rate limiting rule on /login', [w('expression', 'contains', '/login'), w('action', 'one_of', 'block, managed_challenge, challenge')]) },
  { id: 'rl-api', group: 'Rate limiting', title: 'The API is rate limited', why: 'Protects the API from scraping and abuse. Change “/api” to your API path.',
    item: check('http_ratelimit', 'api', 'Rate limiting rule on /api', [w('expression', 'contains', '/api'), w('action', 'one_of', 'block, managed_challenge, challenge')]) },
  { id: 'rl-not-log', group: 'Rate limiting', title: 'No rate limiting rule only logs', why: 'A rule left on Log counts requests but stops none.',
    item: check('http_ratelimit', 'log_only', 'Rate limiting rule that only logs', [w('action', 'equals', 'log')], 'absent') },
  // ── Cache rules ──
  { id: 'cache-static', group: 'Cache rules', title: 'Static assets are cached at the edge', why: 'A cache rule on file extensions (css, js, images, fonts) takes that load off the origin.',
    item: check('http_request_cache_settings', 'static', 'Cache rule for static assets', [w('expression', 'contains', 'http.request.uri.path.extension'), w('action_parameters.cache', 'equals', 'true')]) },
  { id: 'cache-deception', group: 'Cache rules', title: 'Cache Deception Armor is on in a cache rule', why: 'Stops an attacker getting a private page cached under a fake static URL.',
    item: check('http_request_cache_settings', 'deception', 'Cache Deception Armor', [w('action_parameters.cache_key.cache_deception_armor', 'equals', 'true')]) },
  { id: 'cache-bypass-api', group: 'Cache rules', title: 'The API and signed-in pages bypass the cache', why: 'Personal responses must never be cached. Change “/api” to your dynamic paths.',
    item: check('http_request_cache_settings', 'bypass_api', 'Cache bypass for /api', [w('expression', 'contains', '/api'), w('action_parameters.cache', 'equals', 'false')]) },
  // ── Security headers ──
  { id: 'hdr-nosniff', group: 'Security headers', title: 'X-Content-Type-Options: nosniff', why: 'Browsers do not guess content types (stops some XSS).',
    item: check('http_response_headers_transform', 'nosniff', 'Response header X-Content-Type-Options', [w('action_parameters.headers.X-Content-Type-Options.value', 'equals', 'nosniff')]) },
  { id: 'hdr-frame', group: 'Security headers', title: 'X-Frame-Options: DENY or SAMEORIGIN', why: 'Stops other sites framing yours (clickjacking).',
    item: check('http_response_headers_transform', 'frame', 'Response header X-Frame-Options', [w('action_parameters.headers.X-Frame-Options.value', 'one_of', 'DENY, SAMEORIGIN')]) },
  { id: 'hdr-referrer', group: 'Security headers', title: 'Referrer-Policy is set', why: 'Limits what other sites learn from the address of your pages.',
    item: check('http_response_headers_transform', 'referrer', 'Response header Referrer-Policy', [w('action_parameters.headers.Referrer-Policy.operation', 'equals', 'set')]) },
  { id: 'hdr-permissions', group: 'Security headers', title: 'Permissions-Policy is set', why: 'Turns off browser features the site does not use (camera, microphone, location).',
    item: check('http_response_headers_transform', 'permissions', 'Response header Permissions-Policy', [w('action_parameters.headers.Permissions-Policy.operation', 'equals', 'set')]) },
];

/** The entries a new template from the library starts with: all of them. */
export const libraryItems = (ids?: string[]) => LIBRARY.filter((e) => !ids || ids.includes(e.id)).map((e) => e.item);

// ── Libraries ───────────────────────────────────────────────────────────────

import { POLICY_LIBRARY } from './template-policy';
import { CF_DOCS as DOCS } from './cf-best-practices';

/** One entry of a library: a granular check, why it matters, and (for Cloudflare's) the docs page it comes from. */
export interface AnyEntry { id: string; group: string; title: string; why: string; source?: string; item: TemplateItem }
export interface Library { id: string; name: string; description: string; entries: AnyEntry[] }

interface DocEntry { id: string; group: string; title: string; why: string; source: string; check: { setting?: { id: string; match: string; value: string }; rule?: { phase: string; expect: 'present' | 'absent'; conditions: CheckWhen[] } } }

/** One check from Cloudflare's documentation, as a template item. A setting check is "setting:<id>#<check>" (several checks of one setting). */
function fromDocs(d: DocEntry): AnyEntry {
  const short = d.id.replace(/^cf-/, '').replace(/-/g, '_');
  if (d.check.setting) {
    const x = d.check.setting;
    return { id: d.id, group: d.group, title: d.title, why: d.why, source: d.source, item: { item: `setting:${x.id}#${short}`, kind: 'setting', path: d.title, expected: x.value, match: x.match as TemplateMatch } };
  }
  const r = d.check.rule!;
  return { id: d.id, group: d.group, title: d.title, why: d.why, source: d.source,
    item: { item: `check:${r.phase}:${short}`, kind: PHASES.find((p) => p.phase === r.phase)?.kind ?? 'rule', path: d.title, expected: '', match: r.expect, check: { phase: r.phase, when: r.conditions } } };
}

/** Console checks the docs list has no counterpart for, kept beside it. */
const EXTRA: Record<string, string> = {
  'no-skip-all-managed': 'Managed rules and OWASP', 'owasp-action': 'Managed rules and OWASP', 'admin-protect': 'Custom rules', 'no-skip-all-custom': 'Custom rules',
  'rl-api': 'Rate limiting', 'rl-not-log': 'Rate limiting', 'cache-static': 'Cache and CDN', 'cache-bypass-api': 'Cache and CDN', 'dev-mode-off': 'Security settings', 'cache-level': 'Cache and CDN',
};

/** Cloudflare's documented best practices (each with its docs page), and the console's extra checks. */
export const CLOUDFLARE_LIBRARY: AnyEntry[] = [
  ...(DOCS as DocEntry[]).map(fromDocs),
  ...LIBRARY.filter((e) => EXTRA[e.id]).map((e) => ({ ...e, group: EXTRA[e.id], why: `${e.why} (Console check; not from one docs page.)` })),
];

export const LIBRARIES: Library[] = [
  { id: 'cloudflare', name: 'Cloudflare best practices', description: 'Each check comes from Cloudflare’s documentation (the link says which page): SSL/TLS and HSTS, security settings, managed rules and OWASP tuning, attack score and leaked credentials, bots, rate limiting, DDoS, cache, protocols, security headers and DNS. A few console checks the docs have no page for are marked.', entries: CLOUDFLARE_LIBRARY },
  { id: 'policy', name: 'Security policy (POL / RL)', description: 'The POL custom rules and RL rate limiting rules, each split into checks: the rule exists, its action, API exclusion, threshold, counting, origin-only, throttle. Host conditions are left out.', entries: POLICY_LIBRARY },
];
