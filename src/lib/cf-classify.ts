// Classifies Cloudflare audit-log entries into change categories and works out exactly
// what changed (field by field, old → new). Pure functions, no imports — used by the
// server and testable on its own.
//
// Sources (developers.cloudflare.com):
//  - Ruleset Engine phases list: which phase belongs to which product
//    (ruleset-engine/reference/phases-list)
//  - API paths: /zones/{id}/dns_records, /zones/{id}/settings/{setting},
//    /zones/{id}/rulesets/phases/{phase}/entrypoint, /zones/{id}/pagerules …
//  - Audit Logs v2 product categories (GET /accounts/{id}/logs/audit/product_categories),
//    used as the fallback when the request path is not specific enough.

export type CategoryKey =
  | 'onboarding' | 'dns' | 'security' | 'cdn' | 'rules' | 'ssl' | 'zone' | 'traffic'
  | 'zerotrust' | 'developer' | 'access' | 'logs' | 'email' | 'billing' | 'other';

export const CATEGORIES: { key: CategoryKey; label: string; description: string }[] = [
  { key: 'onboarding', label: 'Zone onboarding', description: 'Zones added to or removed from Cloudflare, activation and plan changes' },
  { key: 'dns', label: 'DNS changes', description: 'DNS records, DNSSEC and DNS settings' },
  { key: 'security', label: 'Security rule changes', description: 'WAF custom and managed rules, rate limiting, bots, DDoS, IP access rules, API Shield, Page Shield' },
  { key: 'cdn', label: 'CDN & cache rule changes', description: 'Cache Rules, Page Rules, cache settings and purges, compression, performance settings' },
  { key: 'rules', label: 'Redirect, transform & origin rules', description: 'Single and Bulk Redirects, URL rewrites, header transforms, Origin and Configuration Rules, Custom Errors, Snippets' },
  { key: 'ssl', label: 'SSL/TLS & certificates', description: 'Encryption mode, TLS settings, edge and origin certificates, custom hostnames' },
  { key: 'zone', label: 'Zone settings', description: 'Other zone-level settings' },
  { key: 'traffic', label: 'Load balancing & traffic', description: 'Load balancers, pools, monitors, health checks, Waiting Room, Spectrum' },
  { key: 'zerotrust', label: 'Zero Trust', description: 'Access, Gateway, tunnels and devices' },
  { key: 'developer', label: 'Workers & developer platform', description: 'Workers, Pages, R2, KV, D1, Queues, Images, Stream' },
  { key: 'access', label: 'Members, roles & API tokens', description: 'Account members, roles and API tokens' },
  { key: 'logs', label: 'Logs & analytics', description: 'Logpush jobs and log settings' },
  { key: 'email', label: 'Email', description: 'Email Routing and Email Security' },
  { key: 'billing', label: 'Billing & plans', description: 'Subscriptions and plan changes' },
  { key: 'other', label: 'Other changes', description: 'Changes that fit no category above' },
];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<CategoryKey, string>;

// ── Ruleset phases (official phases list) ─────────────────────────────────────

const PHASES: Record<string, [CategoryKey, string]> = {
  http_request_firewall_custom: ['security', 'WAF custom rules'],
  http_request_firewall_managed: ['security', 'WAF Managed Rules'],
  http_ratelimit: ['security', 'Rate limiting rules'],
  http_request_sbfm: ['security', 'Super Bot Fight Mode'],
  ddos_l7: ['security', 'HTTP DDoS Attack Protection'],
  ddos_l4: ['security', 'Network-layer DDoS Attack Protection'],
  http_response_firewall_managed: ['security', 'Sensitive Data Detection'],
  magic_transit: ['security', 'Network Firewall'],
  magic_transit_managed: ['security', 'Network Firewall managed rulesets'],
  magic_transit_ratelimit: ['security', 'Network Firewall rate limiting'],
  magic_transit_ids_managed: ['security', 'Network Firewall IDS'],
  http_request_cache_settings: ['cdn', 'Cache Rules'],
  http_response_compression: ['cdn', 'Compression Rules'],
  http_request_dynamic_redirect: ['rules', 'Single Redirects'],
  http_request_redirect: ['rules', 'Bulk Redirects'],
  http_request_transform: ['rules', 'URL Rewrite Rules'],
  http_request_late_transform: ['rules', 'Request Header Transform Rules'],
  http_response_headers_transform: ['rules', 'Response Header Transform Rules'],
  http_request_origin: ['rules', 'Origin Rules'],
  http_config_settings: ['rules', 'Configuration Rules'],
  http_request_sanitize: ['rules', 'URL normalization'],
  http_custom_errors: ['rules', 'Custom Errors'],
  http_request_snippets: ['rules', 'Snippets'],
  http_request_cloud_connector: ['rules', 'Cloud Connector'],
  http_log_custom_fields: ['logs', 'Logpush custom fields'],
};

// ── Zone settings (/zones/{id}/settings/{setting}) ────────────────────────────

const SETTING_CATEGORY: Record<string, CategoryKey> = {};
const settingGroup = (cat: CategoryKey, ids: string[]) => { for (const id of ids) SETTING_CATEGORY[id] = cat; };
settingGroup('ssl', ['ssl', 'min_tls_version', 'tls_1_3', 'always_use_https', 'automatic_https_rewrites', 'opportunistic_encryption',
  'tls_client_auth', 'ciphers', 'ssl_recommender', 'security_header', 'origin_max_http_version', 'h2_prioritization']);
settingGroup('security', ['security_level', 'waf', 'browser_check', 'challenge_ttl', 'email_obfuscation', 'hotlink_protection',
  'server_side_exclude', 'privacy_pass', 'replace_insecure_js', 'advanced_ddos', 'bot_management', 'aegis']);
settingGroup('cdn', ['cache_level', 'browser_cache_ttl', 'development_mode', 'always_online', 'rocket_loader', 'minify', 'polish',
  'brotli', 'early_hints', 'mirage', 'image_resizing', 'webp', 'http2', 'http3', '0rtt', 'sort_query_string_for_cache', 'edge_cache_ttl',
  'prefetch_preload', 'response_buffering', 'speed_brain', 'fonts', 'cache_reserve', 'tiered_caching', 'origin_error_page_pass_thru',
  'automatic_platform_optimization', 'orange_to_orange', 'proxy_read_timeout']);

// ── Path rules: first match wins ──────────────────────────────────────────────

const PATH_RULES: [RegExp, CategoryKey, string][] = [
  [/\/dns_records/, 'dns', 'DNS records'],
  [/\/dnssec/, 'dns', 'DNSSEC'],
  [/\/dns_settings|\/dns_firewall|\/secondary_dns|\/dns\//, 'dns', 'DNS settings'],
  [/\/firewall\/access_rules/, 'security', 'IP Access rules'],
  [/\/firewall\/ua_rules/, 'security', 'User Agent Blocking'],
  [/\/firewall\/lockdowns/, 'security', 'Zone Lockdown'],
  [/\/firewall\/rules|\/filters/, 'security', 'Firewall rules (legacy)'],
  [/\/firewall\/waf|\/waf\//, 'security', 'WAF (legacy)'],
  [/\/rate_limits/, 'security', 'Rate limiting (legacy)'],
  [/\/bot_management|\/bot_fight/, 'security', 'Bot Management'],
  [/\/page_shield/, 'security', 'Page Shield'],
  [/\/api_gateway|\/schema_validation/, 'security', 'API Shield'],
  [/\/security_center|\/content-upload-scan|\/leaked-credential-checks/, 'security', 'Security settings'],
  [/\/pagerules/, 'cdn', 'Page Rules'],
  [/\/purge_cache/, 'cdn', 'Cache purge'],
  [/\/cache\//, 'cdn', 'Cache settings'],
  [/\/argo\//, 'cdn', 'Argo Smart Routing'],
  [/\/speed_api|\/smart_shield/, 'cdn', 'Performance'],
  [/\/custom_hostnames/, 'ssl', 'Custom hostnames'],
  [/\/custom_certificates|\/ssl\/|\/certificates|\/origin_tls_client_auth|\/acm\/|\/mtls_certificates|\/hostnames\/settings/, 'ssl', 'Certificates'],
  [/\/load_balancers|\/load_balancing/, 'traffic', 'Load Balancing'],
  [/\/healthchecks/, 'traffic', 'Health checks'],
  [/\/waiting_rooms/, 'traffic', 'Waiting Room'],
  [/\/spectrum/, 'traffic', 'Spectrum'],
  [/\/access\/|\/gateway|\/teamnet|\/devices|\/cfd_tunnel|\/tunnels|\/zerotrust/, 'zerotrust', 'Zero Trust'],
  [/\/workers|\/pages\/|\/r2\/|\/storage\/kv|\/d1\/|\/queues|\/images\/|\/stream|\/ai\/|\/hyperdrive|\/vectorize/, 'developer', 'Developer platform'],
  [/\/members|\/roles|\/memberships/, 'access', 'Members & roles'],
  [/\/tokens/, 'access', 'API tokens'],
  [/\/logpush|\/logs\/(?!audit)/, 'logs', 'Logs'],
  [/\/email\//, 'email', 'Email'],
  [/\/subscriptions|\/billing|\/available_plans/, 'billing', 'Billing'],
];

// Product names (resource.product) and official category labels, as the last resort.
const KEYWORDS: [RegExp, CategoryKey][] = [
  [/\bdns/i, 'dns'],
  [/waf|firewall|security|bot|ddos|rate.?limit|shield|access rules|lockdown/i, 'security'],
  [/cache|cdn|performance|speed|argo|compression|page.?rule/i, 'cdn'],
  [/redirect|transform|rewrite|origin rule|configuration rule|snippet|custom error/i, 'rules'],
  [/ssl|tls|certificat|hostname/i, 'ssl'],
  [/load.?balanc|health|waiting|spectrum|traffic/i, 'traffic'],
  [/zero.?trust|access|gateway|tunnel|device/i, 'zerotrust'],
  [/worker|pages|r2|kv|d1|queue|image|stream|developer|durable/i, 'developer'],
  [/member|role|token|user/i, 'access'],
  [/log/i, 'logs'],
  [/email/i, 'email'],
  [/billing|subscription|plan/i, 'billing'],
  [/zone/i, 'zone'],
];

export interface ClassifyInput {
  method: string;
  uri: string;
  product: string;
  resourceType: string;
  actionType: string;
  description: string;
  /** Cloudflare's own category label for this product, when known. */
  officialCategory?: string;
  state?: unknown;
}

const settingTitle = (id: string) => id.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function classify(e: ClassifyInput): { category: CategoryKey; feature: string } {
  const path = (e.uri || '').split('?')[0].replace(/^\/client\/v4/, '');
  // Zones themselves: POST /zones adds one, DELETE /zones/{id} removes it.
  if (/^\/zones\/?$/.test(path) && e.method === 'POST') return { category: 'onboarding', feature: 'Zone added' };
  if (/^\/zones\/[^/]+\/?$/.test(path)) {
    if (e.method === 'DELETE') return { category: 'onboarding', feature: 'Zone removed' };
    return { category: 'onboarding', feature: 'Zone (plan, type, pause)' };
  }
  if (/\/activation_check/.test(path)) return { category: 'onboarding', feature: 'Activation check' };
  const setting = /\/zones\/[^/]+\/settings\/([a-z0-9_]+)/.exec(path)?.[1];
  if (setting) return { category: SETTING_CATEGORY[setting] ?? 'zone', feature: `Setting: ${settingTitle(setting)}` };
  if (/\/zones\/[^/]+\/settings\/?$/.test(path)) return { category: 'zone', feature: 'Zone settings' };
  if (/\/rulesets/.test(path)) {
    const phase = /\/phases\/([a-z0-9_]+)/.exec(path)?.[1] ?? statePhase(e.state);
    const p = phase ? PHASES[phase] : undefined;
    if (p) return { category: p[0], feature: p[1] };
  }
  for (const [re, cat, feature] of PATH_RULES) if (re.test(path)) return { category: cat, feature };
  const product = e.product || '';
  for (const [re, cat] of KEYWORDS) if (product && re.test(product)) return { category: cat, feature: titleCase(product) };
  if (e.officialCategory) for (const [re, cat] of KEYWORDS) if (re.test(e.officialCategory)) return { category: cat, feature: titleCase(product || e.officialCategory) };
  if (/zone/i.test(e.resourceType)) return { category: 'zone', feature: titleCase(e.resourceType) };
  return { category: 'other', feature: titleCase(product || e.resourceType || 'Other') };
}

const titleCase = (s: string) => s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

function statePhase(state: unknown): string | undefined {
  return isObj(state) && typeof state.phase === 'string' ? state.phase : undefined;
}

// ── State and diff ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Cloudflare responses are usually the API envelope; the resource is its `result`. */
export function unwrap(v: unknown): unknown {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v; } }
  if (isObj(v) && 'result' in v && ('success' in v || 'errors' in v)) return v.result;
  return v;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (isObj(v) && !Object.keys(v).length) || (Array.isArray(v) && !v.length);

/** The resource's state after this change: the response body, else what was sent. */
export function stateAfter(actionType: string, request: unknown, response: unknown): unknown {
  if (actionType === 'delete') return null;
  const res = unwrap(response);
  if (!isEmpty(res)) return res;
  const req = unwrap(request);
  return isEmpty(req) ? undefined : req;
}

export const SECRET_KEY = /secret|password|passwd|token|private|credential|authorization|api_?key|client_?key|certificate|signing|psk/i;
/** Metadata that changes on every write and says nothing about what was changed. */
const NOISE_KEY = /^(modified_on|modified|last_modified|updated_at|updated_on|etag|last_updated|meta)$/;

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 10) return '…';
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => redact(x, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '••••••••' : redact(x, depth + 1)]));
  return v;
}

export interface FieldChange { path: string; old?: string; new?: string }

const MAX_VALUE = 300;
const MAX_CHANGES = 40;
export const show = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}…` : s;
};
/** Name an array element by its id, name or description so paths read "rules[block bad bots]". */
const elemKey = (v: Record<string, unknown>) => String(v.description || v.name || v.ref || v.id);
const keyed = (a: unknown[]) => a.length > 0 && a.every((x) => isObj(x) && (typeof x.id === 'string' || typeof x.ref === 'string'));

/** Field-by-field differences between two states (secrets already redacted by the caller). */
export function diff(oldV: unknown, newV: unknown, path = '', out: FieldChange[] = []): FieldChange[] {
  if (out.length >= MAX_CHANGES) return out;
  if (isObj(oldV) && isObj(newV)) {
    for (const k of [...new Set([...Object.keys(oldV), ...Object.keys(newV)])].sort()) {
      if (NOISE_KEY.test(k)) continue;
      diff(oldV[k], newV[k], path ? `${path}.${k}` : k, out);
    }
    return out;
  }
  if (Array.isArray(oldV) && Array.isArray(newV) && keyed(oldV) && keyed(newV)) {
    const id = (x: unknown) => String((x as Record<string, unknown>).id ?? (x as Record<string, unknown>).ref);
    const before = new Map(oldV.map((x) => [id(x), x as Record<string, unknown>]));
    const after = new Map(newV.map((x) => [id(x), x as Record<string, unknown>]));
    for (const [k, x] of after) {
      const p = `${path}[${elemKey(x)}]`;
      if (!before.has(k)) out.push({ path: p, new: show(x) });
      else diff(before.get(k), x, p, out);
    }
    for (const [k, x] of before) if (!after.has(k)) out.push({ path: `${path}[${elemKey(x)}]`, old: show(x) });
    return out;
  }
  if (JSON.stringify(oldV) !== JSON.stringify(newV)) out.push({ path: path || '(value)', old: show(oldV), new: show(newV) });
  return out;
}

/** Identifiers of a whole created/deleted resource; the change title already names it. */
const ID_KEY = /^(id|zone_id|zone_name|account_id|created_on|created)$/;

/** Fields of a created (or deleted) resource, as a flat list. */
export function fields(v: unknown, side: 'new' | 'old'): FieldChange[] {
  if (!isObj(v)) return v === undefined || v === null ? [] : [{ path: '(value)', [side]: show(v) }];
  const keep = Object.entries(v).filter(([k, x]) => !NOISE_KEY.test(k) && !isEmpty(x));
  const named = keep.filter(([k]) => !ID_KEY.test(k));
  return (named.length ? named : keep).slice(0, MAX_CHANGES).map(([k, x]) => ({ path: k, [side]: show(x) }));
}

/** A short name for what was changed: "A www.example.com", a rule's description, a setting id … */
export function targetName(state: unknown, fallback: string): string {
  const s = isObj(state) ? state : {};
  // A phase entrypoint ruleset is named by its phase, which is already the feature ("WAF custom rules").
  if (typeof s.phase === 'string' && Array.isArray(s.rules)) return '';
  if (typeof s.type === 'string' && typeof s.name === 'string' && 'content' in s) return `${s.type} ${s.name}`;
  for (const k of ['name', 'description', 'hostname', 'pattern', 'title', 'email']) if (typeof s[k] === 'string' && s[k]) return s[k] as string;
  if (typeof s.id === 'string' && typeof s.value !== 'undefined') return s.id;
  return fallback;
}

/** Groups entries that change the same thing, so the previous entry's state is this one's old value. */
export function resourceKey(e: { accountId: string; zoneId: string; product: string; resourceType: string; resourceId: string; uri: string; method: string }): string {
  const path = (e.uri || '').split('?')[0].replace(/^\/client\/v4/, '');
  if (e.resourceId) return [e.accountId, e.zoneId, e.product, e.resourceType, e.resourceId].join('|');
  // POST to a collection creates a new resource; it has no earlier state.
  if (e.method === 'POST') return '';
  return [e.accountId, path].join('|');
}
