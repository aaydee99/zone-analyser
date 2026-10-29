// What the Zone explorer reads for one zone: read-only GET endpoints from Cloudflare's API reference
// (its OpenAPI schema, github.com/cloudflare/api-schemas — what Terraform provider v5 and the v5 SDKs
// are generated from). Only current APIs: nothing the schema marks deprecated is read, including the
// bulk /settings endpoint (settings are read one by one) and the legacy firewall APIs. Analytics,
// plan catalogs, bulk exports and eligibility checks are left out: they are not zone configuration.
// Shared by server and client — no Node imports.

/** Sections, in the order the explorer (page, CSV and JSON) shows them. */
export type ZoneGroup = 'zone' | 'dns' | 'email' | 'ssl' | 'security_rules' | 'security' | 'speed' | 'cache' | 'cache_rules' | 'cdn_rules' | 'network'
  | 'traffic' | 'workers' | 'api_shield' | 'zero_trust' | 'logs' | 'other';

export const ZONE_GROUPS: { key: ZoneGroup; label: string }[] = [
  { key: 'zone', label: 'Zone settings' },
  { key: 'dns', label: 'DNS' },
  { key: 'email', label: 'Email' },
  { key: 'ssl', label: 'SSL / TLS' },
  { key: 'security_rules', label: 'Security rules' },
  { key: 'security', label: 'Security settings' },
  { key: 'speed', label: 'Speed settings' },
  { key: 'cache', label: 'Cache settings' },
  { key: 'cache_rules', label: 'Cache rules' },
  { key: 'cdn_rules', label: 'CDN rules' },
  { key: 'network', label: 'Network settings' },
  // Not in the dashboard's settings and rules pages, kept after them.
  { key: 'traffic', label: 'Traffic & load balancing' },
  { key: 'workers', label: 'Workers & Zaraz' },
  { key: 'api_shield', label: 'API Shield' },
  { key: 'zero_trust', label: 'Zone-level Zero Trust' },
  { key: 'logs', label: 'Logs & observability' },
  { key: 'other', label: 'Other' },
];

export interface ZoneEndpoint {
  key: string;
  /** Path after /zones/{zone_id}; '' is the zone itself. */
  path: string;
  label: string;
  group: ZoneGroup;
  /** Page size for list endpoints (the documented maximum, or a safe size). */
  perPage?: number;
}

const e = (group: ZoneGroup, path: string, label: string, perPage?: number): ZoneEndpoint =>
  ({ key: path ? path.slice(1).replace(/[/-]/g, '_') : 'zone', path, label, group, ...(perPage ? { perPage } : {}) });

export const ZONE_ENDPOINTS: ZoneEndpoint[] = [
  e('zone', '', 'Zone details'),
  e('zone', '/subscription', 'Subscription'),
  e('zone', '/hold', 'Zone hold'),

  e('dns', '/dns_records', 'DNS records', 5000),
  e('dns', '/dns_settings', 'DNS settings'),
  e('dns', '/dnssec', 'DNSSEC'),
  e('dns', '/dns_records/usage', 'DNS record usage'),
  e('dns', '/secondary_dns/incoming', 'Secondary DNS (incoming)'),
  e('dns', '/secondary_dns/outgoing', 'Secondary DNS (outgoing)'),

  e('email', '/email/routing', 'Email Routing'),
  e('email', '/email/routing/dns', 'Email Routing DNS'),
  e('email', '/email/routing/rules', 'Email Routing rules', 50),
  e('email', '/email/routing/rules/catch_all', 'Email Routing catch-all rule'),
  e('email', '/email/auth/dmarc-reports', 'DMARC reports'),

  e('ssl', '/ssl/universal/settings', 'Universal SSL'),
  e('ssl', '/ssl/certificate_packs', 'Edge certificates (certificate packs)', 50),
  e('ssl', '/ssl/certificate_packs/quota', 'Certificate pack quota'),
  e('ssl', '/ssl/verification', 'SSL verification'),
  e('ssl', '/settings/ssl_automatic_mode', 'Automatic SSL/TLS mode'),
  e('ssl', '/acm/total_tls', 'Total TLS'),
  e('ssl', '/acm/custom_trust_store', 'Custom origin trust store', 50),
  e('ssl', '/custom_certificates', 'Custom certificates', 50),
  e('ssl', '/keyless_certificates', 'Keyless SSL'),
  e('ssl', '/origin_tls_client_auth/settings', 'Authenticated Origin Pulls'),
  e('ssl', '/origin_tls_client_auth', 'Authenticated Origin Pulls certificates'),
  e('ssl', '/origin_tls_client_auth/hostnames', 'Per-hostname Authenticated Origin Pulls', 1000),
  e('ssl', '/origin_tls_client_auth/hostnames/certificates', 'Per-hostname AOP certificates'),
  e('ssl', '/settings/origin_tls_compliance_modes', 'Origin TLS compliance modes'),
  e('ssl', '/settings/auto_origin_tls_kex', 'Auto origin TLS key exchange'),
  e('ssl', '/custom_hostnames', 'Custom hostnames (SSL for SaaS)', 1000),
  e('ssl', '/custom_hostnames/fallback_origin', 'Custom hostname fallback origin'),
  e('ssl', '/custom_hostnames/quota', 'Custom hostname quota'),
  e('ssl', '/client_certificates', 'Client certificates (mTLS)', 50),
  e('ssl', '/certificate_authorities/hostname_associations', 'mTLS hostname associations'),
  e('ssl', '/ct/alerting', 'Certificate Transparency alerting'),
  e('ssl', '/dcv_delegation/uuid', 'DCV delegation id'),

  e('security_rules', '/firewall/access_rules/rules', 'IP Access rules', 1000),
  e('security_rules', '/firewall/ua_rules', 'User Agent blocking', 1000),
  e('security_rules', '/firewall/lockdowns', 'Zone Lockdown', 1000),

  e('security', '/bot_management', 'Bot Management'),
  e('security', '/page_shield', 'Page Shield (client-side security)'),
  e('security', '/page_shield/policies', 'Page Shield policies'),
  e('security', '/page_shield/scripts', 'Page Shield detected scripts', 100),
  e('security', '/page_shield/connections', 'Page Shield detected connections', 100),
  e('security', '/page_shield/cookies', 'Page Shield detected cookies', 100),
  e('security', '/leaked-credential-checks', 'Leaked credential checks'),
  e('security', '/leaked-credential-checks/detections', 'Leaked credential detections'),
  e('security', '/content-upload-scan/settings', 'Content scanning'),
  e('security', '/content-upload-scan/payloads', 'Content scanning expressions'),
  e('security', '/fraud_detection/settings', 'Fraud detection'),
  e('security', '/ai-security/settings', 'AI security'),
  e('security', '/ai-security/custom-topics', 'AI security custom topics'),
  e('security', '/ai-audit/robots', 'AI audit robots.txt rules'),
  e('security', '/security-center/securitytxt', 'security.txt'),
  e('security', '/security-center/insights', 'Security Center insights', 1000),

  e('speed', '/settings/fonts', 'Cloudflare Fonts'),
  e('speed', '/settings/speed_brain', 'Speed Brain'),
  e('speed', '/settings/rum', 'Web Analytics (RUM)'),
  e('speed', '/images/v1/flows', 'Image transformation flows'),

  e('cache', '/argo/tiered_caching', 'Tiered caching'),
  e('cache', '/cache/tiered_cache_smart_topology_enable', 'Smart Tiered Cache'),
  e('cache', '/cache/regional_tiered_cache', 'Regional Tiered Cache'),
  e('cache', '/cache/cache_reserve', 'Cache Reserve'),
  e('cache', '/cache/variants', 'Cache variants'),
  e('cache', '/origin/cloud_regions', 'Origin cloud regions', 100),
  e('cache', '/smart_shield', 'Smart Shield'),

  e('cdn_rules', '/pagerules', 'Page Rules'),
  e('cdn_rules', '/managed_headers', 'Managed Transforms'),
  e('cdn_rules', '/url_normalization', 'URL normalization'),
  e('cdn_rules', '/snippets', 'Snippets', 100),
  e('cdn_rules', '/snippets/snippet_rules', 'Snippet rules'),
  e('cdn_rules', '/cloud_connector/rules', 'Cloud Connector rules'),
  e('cdn_rules', '/custom_pages', 'Custom error pages'),
  e('cdn_rules', '/custom_pages/assets', 'Custom error page assets', 200),

  e('network', '/argo/smart_routing', 'Argo Smart Routing'),

  e('traffic', '/load_balancers', 'Load balancers'),
  e('traffic', '/healthchecks', 'Health checks', 1000),
  e('traffic', '/spectrum/apps', 'Spectrum applications', 100),
  e('traffic', '/waiting_rooms', 'Waiting rooms', 1000),
  e('traffic', '/waiting_rooms/settings', 'Waiting room settings'),
  e('traffic', '/addressing/regional_hostnames', 'Regional hostnames (Data Localization)'),
  e('traffic', '/web3/hostnames', 'Web3 hostnames'),

  e('workers', '/workers/routes', 'Worker routes'),
  e('workers', '/settings/zaraz/config', 'Zaraz configuration'),

  e('api_shield', '/api_gateway/configuration', 'Session identifiers'),
  e('api_shield', '/api_gateway/operations', 'Endpoints (operations)', 50),
  e('api_shield', '/api_gateway/labels', 'Operation labels', 50),
  e('api_shield', '/schema_validation/settings', 'Schema validation settings'),
  e('api_shield', '/schema_validation/settings/operations', 'Per-operation schema validation', 50),
  e('api_shield', '/schema_validation/schemas', 'Uploaded schemas', 50),
  e('api_shield', '/token_validation/config', 'Token validation configurations', 50),
  e('api_shield', '/token_validation/rules', 'Token validation rules', 50),

  e('zero_trust', '/access/apps', 'Access applications'),
  e('zero_trust', '/access/groups', 'Access groups'),
  e('zero_trust', '/access/identity_providers', 'Identity providers'),
  e('zero_trust', '/access/organizations', 'Zero Trust organization'),
  e('zero_trust', '/access/service_tokens', 'Service tokens'),
  e('zero_trust', '/access/certificates', 'mTLS certificates'),
  e('zero_trust', '/access/certificates/settings', 'mTLS hostname settings'),
  e('zero_trust', '/access/apps/ca', 'Short-lived certificate CAs'),

  e('logs', '/logpush/jobs', 'Logpush jobs'),
  e('logs', '/logpush/edge/jobs', 'Instant Logs jobs'),
  e('logs', '/logs/control/retention/flag', 'Log retention'),
  e('logs', '/logs/explorer/datasets', 'Log Explorer datasets'),
  e('logs', '/observability/tracing/settings', 'Tracing settings'),
  e('logs', '/observability/tracing/rules', 'Tracing rules'),

  e('other', '/rulesets', 'All rulesets (including managed)', 50),
  e('other', '/pay-per-crawl/configuration', 'Pay per crawl'),
  e('other', '/monetization/rules', 'Monetization rules'),
  e('other', '/devices/policy/certificates', 'Device certificate provisioning'),
];

/**
 * Zone settings, each read with GET /settings/{setting_id}: the ids in the schema's response for that
 * endpoint, without the five it marks deprecated (cname_flattening, mirage, orange_to_orange,
 * privacy_pass, response_buffering).
 */
export const SETTING_IDS = [
  '0rtt', 'advanced_ddos', 'aegis', 'always_online', 'always_use_https', 'automatic_https_rewrites', 'automatic_platform_optimization', 'brotli',
  'browser_cache_ttl', 'browser_check', 'cache_level', 'challenge_ttl', 'china_network_enabled', 'ciphers', 'content_converter', 'development_mode',
  'early_hints', 'edge_cache_ttl', 'email_obfuscation', 'h2_prioritization', 'hotlink_protection', 'http2', 'http3', 'image_resizing', 'ip_geolocation',
  'ipv6', 'max_upload', 'min_tls_version', 'nel', 'opportunistic_encryption', 'opportunistic_onion', 'origin_error_page_pass_thru', 'origin_h2_max_streams',
  'origin_max_http_version', 'polish', 'pre_render', 'prefetch_preload', 'proxy_read_timeout', 'pseudo_ipv4', 'redirects_for_ai_training', 'replace_insecure_js',
  'rocket_loader', 'search_for_agents', 'security_header', 'security_level', 'server_side_exclude', 'sha1_support', 'sort_query_string_for_cache', 'ssl',
  'ssl_recommender', 'tls_1_2_only', 'tls_1_3', 'tls_client_auth', 'transformations', 'transformations_allowed_origins', 'true_client_ip_header', 'waf',
  'webmcp_enabled', 'webmcp_mcp_url', 'webmcp_packs', 'webp', 'websockets',
];

/** Settings section of each setting, as the dashboard places them. */
export type SettingGroup = 'zone' | 'ssl' | 'security' | 'speed' | 'cache' | 'network';
const SETTING_SECTIONS: Record<SettingGroup, string[]> = {
  zone: ['content_converter', 'redirects_for_ai_training', 'search_for_agents', 'webmcp_enabled', 'webmcp_mcp_url', 'webmcp_packs'],
  ssl: ['always_use_https', 'automatic_https_rewrites', 'ciphers', 'min_tls_version', 'opportunistic_encryption', 'security_header', 'sha1_support', 'ssl', 'ssl_recommender', 'tls_1_2_only', 'tls_1_3', 'tls_client_auth'],
  security: ['advanced_ddos', 'browser_check', 'challenge_ttl', 'email_obfuscation', 'hotlink_protection', 'replace_insecure_js', 'security_level', 'server_side_exclude', 'waf'],
  speed: ['0rtt', 'automatic_platform_optimization', 'brotli', 'early_hints', 'h2_prioritization', 'http2', 'http3', 'image_resizing', 'polish', 'pre_render', 'prefetch_preload', 'rocket_loader', 'transformations', 'transformations_allowed_origins', 'webp'],
  cache: ['always_online', 'browser_cache_ttl', 'cache_level', 'development_mode', 'edge_cache_ttl', 'sort_query_string_for_cache'],
  network: ['aegis', 'china_network_enabled', 'ip_geolocation', 'ipv6', 'max_upload', 'nel', 'opportunistic_onion', 'origin_error_page_pass_thru', 'origin_h2_max_streams', 'origin_max_http_version', 'proxy_read_timeout', 'pseudo_ipv4', 'true_client_ip_header', 'websockets'],
};
export const SETTING_GROUP: Record<string, SettingGroup> = Object.fromEntries(
  (Object.entries(SETTING_SECTIONS) as [SettingGroup, string[]][]).flatMap(([g, ids]) => ids.map((id) => [id, g])),
);
export const SETTING_LABEL: Record<SettingGroup, string> = {
  zone: 'General settings', ssl: 'SSL/TLS settings', security: 'Security settings', speed: 'Speed settings', cache: 'Cache settings', network: 'Network settings',
};

/** The section each rule page is shown in. */
export type RuleArea = 'security_rules' | 'cache_rules' | 'cdn_rules';

/**
 * The dashboard's rule pages, each one ruleset phase read with
 * GET /rulesets/phases/{ruleset_phase}/entrypoint (phases from the schema's enum for that endpoint).
 * Left out: magic_transit*, ddos_l4 and http_request_redirect (Bulk Redirects), which are account-level.
 */
export const RULE_PHASES: { phase: string; label: string; area: RuleArea }[] = [
  { phase: 'http_request_firewall_custom', label: 'Custom rules', area: 'security_rules' },
  { phase: 'http_ratelimit', label: 'Rate limiting rules', area: 'security_rules' },
  { phase: 'http_request_firewall_managed', label: 'Managed rules', area: 'security_rules' },
  { phase: 'http_request_sbfm', label: 'Super Bot Fight Mode', area: 'security_rules' },
  { phase: 'http_response_firewall_custom', label: 'Custom rules (responses)', area: 'security_rules' },
  { phase: 'http_response_firewall_managed', label: 'Managed rules (responses, sensitive data)', area: 'security_rules' },
  { phase: 'ddos_l7', label: 'HTTP DDoS attack protection', area: 'security_rules' },
  { phase: 'http_request_dynamic_redirect', label: 'Redirect Rules', area: 'cdn_rules' },
  { phase: 'http_request_transform', label: 'URL Rewrite Rules', area: 'cdn_rules' },
  { phase: 'http_request_late_transform', label: 'Request Header Transform Rules', area: 'cdn_rules' },
  { phase: 'http_response_headers_transform', label: 'Response Header Transform Rules', area: 'cdn_rules' },
  { phase: 'http_request_origin', label: 'Origin Rules', area: 'cdn_rules' },
  { phase: 'http_config_settings', label: 'Configuration Rules', area: 'cdn_rules' },
  { phase: 'http_request_cache_settings', label: 'Cache Rules', area: 'cache_rules' },
  { phase: 'http_response_cache_settings', label: 'Cache Response Rules', area: 'cache_rules' },
  { phase: 'http_response_compression', label: 'Compression Rules', area: 'cdn_rules' },
  { phase: 'http_custom_errors', label: 'Custom Error Rules', area: 'cdn_rules' },
  { phase: 'http_request_sanitize', label: 'URL normalization rules', area: 'cdn_rules' },
  { phase: 'http_log_custom_fields', label: 'Logpush custom fields', area: 'cdn_rules' },
];

/** One dashboard rule page: the phase's entrypoint ruleset and its rules, in order. */
export interface ZoneRulePhase {
  phase: string;
  label: string;
  area: RuleArea;
  /** ok: rules read · empty: nothing configured (no entrypoint) · unavailable/error: see message. */
  status: SectionStatus;
  http: number | null;
  message?: string;
  rulesetId?: string;
  version?: string;
  lastUpdated?: string;
  rules: Record<string, unknown>[];
}

/** One zone the stored tokens can read. */
export interface ZoneListItem {
  id: string;
  name: string;
  status: string;
  type: string;
  plan: string;
  paused: boolean;
  accountId: string;
  accountName: string;
  nameServers: string[];
  createdOn: string;
  activatedOn: string | null;
  /** Stored credentials whose token can read this zone. */
  credentials: string[];
}

export type SectionStatus = 'ok' | 'empty' | 'unavailable' | 'error';

export interface ZoneSection {
  key: string;
  label: string;
  group: ZoneGroup;
  path: string;
  status: SectionStatus;
  /** HTTP status of the (last) request. */
  http: number | null;
  /** Why it is unavailable or failed (Cloudflare's message). */
  message?: string;
  /** Items, for lists. */
  count?: number;
  /** More items than the explorer reads. */
  truncated?: boolean;
  data?: unknown;
}

export interface ZoneReport {
  zone: ZoneListItem;
  generatedAt: string;
  /** Set when this report came from the cache instead of a fresh read. */
  cachedIn?: 'redis' | 'memory';
  credentialName: string;
  sections: ZoneSection[];
  /** The dashboard's rule pages, in dashboard order (shown in Security rules, Cache rules and CDN rules). */
  rules: ZoneRulePhase[];
  /** Names of the rulesets the zone can use (managed rulesets too), for "execute" rules. */
  rulesetNames: Record<string, string>;
}

/** The explorer's sections that have something to read (endpoints, settings or rule pages), in order. */
export const READ_GROUPS = ZONE_GROUPS.filter((g) =>
  ZONE_ENDPOINTS.some((e) => e.group === g.key) || SETTING_IDS.some((id) => SETTING_GROUP[id] === g.key) || RULE_PHASES.some((p) => p.area === g.key));

/** GET /api/zone-explorer/{id}: the zone and where each of its sections and downloads is. */
export interface ZoneSummary {
  zone: ZoneListItem;
  credentialName: string;
  sections: { key: ZoneGroup; label: string; href: string }[];
  downloads: { json: string; csv: string; dnsCsv: string; bind: string; report: string; certificates: string; hosts: string };
}

/** GET /api/zone-explorer/{id}/sections/{group}: one section of the explorer, read and cached on its own. */
export interface ZoneGroupReport {
  zoneId: string;
  zoneName: string;
  group: ZoneGroup;
  label: string;
  generatedAt: string;
  /** Set when this came from the cache instead of a fresh read. */
  cachedIn?: 'redis' | 'memory';
  credentialName: string;
  sections: ZoneSection[];
  rules: ZoneRulePhase[];
  /** Ruleset names for "execute" rules (only for sections with rule pages). */
  rulesetNames: Record<string, string>;
}
