// The read-only API console: which paths it may GET, the placeholders it fills in, and the next
// page of a list. Shared by server and client — no Node imports.

/** Answers larger than this are cut, with a notice. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_PATH = 1024;
export const MAX_SAVED = 100;

/** The first part of every path the console may read. */
export const ROOTS = ['accounts', 'zones', 'user', 'memberships', 'ips', 'radar', 'certificates', 'organizations'] as const;
/**
 * Reads that answer a secret in plain text (a tunnel's or WARP connector's token): refused, as the
 * console never shows a credential.
 */
const DENIED = [/\/token$/i, /\/tokens?\/[^/]+\/value$/i];

export class PathError extends Error {}

export interface PathIds { accountId?: string; zoneId?: string }

/** Fills {account_id} and {zone_id}; any other {placeholder} left is an error. */
export function fillPath(template: string, ids: PathIds): string {
  const out = template.trim()
    .replace(/\{account_id\}|:account_id\b|\$ACCOUNT_ID\b/gi, () => { if (!ids.accountId) throw new PathError('Choose an account for {account_id}'); return ids.accountId; })
    .replace(/\{zone_id\}|:zone_id\b|\$ZONE_ID\b/gi, () => { if (!ids.zoneId) throw new PathError('Choose a zone for {zone_id}'); return ids.zoneId; });
  const left = /\{[a-z_]+\}/i.exec(out);
  if (left) throw new PathError(`Fill in ${left[0]}`);
  return out;
}

/**
 * The path as the console sends it (after https://api.cloudflare.com/client/v4), or a PathError:
 * a relative path under one of ROOTS, no scheme or host, no dot segments, no backslashes, no
 * fragment, printable ASCII only.
 */
export function checkPath(raw: string): string {
  let p = String(raw ?? '').trim();
  if (!p) throw new PathError('Enter a path, e.g. /zones/{zone_id}/dns_records');
  if (p.length > MAX_PATH) throw new PathError(`The path is longer than ${MAX_PATH} characters`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('//')) throw new PathError('Enter a path, not a URL: only api.cloudflare.com/client/v4 is read');
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/^\/client\/v4(?=\/|$)/i, '') || '/';
  if (!/^[\x21-\x7e]+$/.test(p)) throw new PathError('The path may contain only printable characters, without spaces (encode them as %20)');
  const [pathname, query = ''] = p.split(/\?(.*)/s, 2);
  if (/[\\#]/.test(p) || pathname.includes('//')) throw new PathError('The path may not contain \\, # or //');
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw new PathError('The path has a broken %-escape'); }
  if (decoded.split('/').some((s) => s === '.' || s === '..') || /[\\]|\/\//.test(decoded)) throw new PathError('The path may not contain . or .. segments');
  const root = pathname.split('/')[1] ?? '';
  if (!(ROOTS as readonly string[]).includes(root)) throw new PathError(`The path must start with ${ROOTS.map((r) => `/${r}`).join(', ')}`);
  if (DENIED.some((r) => r.test(pathname.replace(/\/$/, '')))) throw new PathError('This path answers a secret (a token), which the console never shows');
  if (query.includes('?')) throw new PathError('The query string has a second ?');
  return query ? `${pathname}?${query}` : pathname;
}

export interface ResultInfo { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number; cursor?: string; cursors?: { after?: string } }

/** The same path for the next page (page numbers or a cursor), or null on the last page. */
export function nextPagePath(path: string, info: ResultInfo | null | undefined): string | null {
  if (!info) return null;
  const [pathname, query = ''] = path.split(/\?(.*)/s, 2);
  const q = new URLSearchParams(query);
  const cursor = info.cursor || info.cursors?.after;
  if (cursor) {
    if (info.count === 0) return null;
    q.set('cursor', cursor);
  } else if (info.page && info.total_pages && info.page < info.total_pages) {
    q.set('page', String(info.page + 1));
  } else return null;
  return `${pathname}?${q}`;
}

/** Common reads, offered as the path is typed. */
export const COMMON_PATHS: { path: string; label: string }[] = [
  { path: '/user/tokens/verify', label: 'This token: status' },
  { path: '/accounts', label: 'Accounts this token reaches' },
  { path: '/accounts/{account_id}', label: 'Account details' },
  { path: '/accounts/{account_id}/members', label: 'Account members' },
  { path: '/accounts/{account_id}/tokens', label: 'Account API tokens' },
  { path: '/accounts/{account_id}/audit_logs?per_page=50', label: 'Account audit log' },
  { path: '/accounts/{account_id}/workers/scripts', label: 'Workers' },
  { path: '/accounts/{account_id}/pages/projects', label: 'Pages projects' },
  { path: '/accounts/{account_id}/r2/buckets', label: 'R2 buckets' },
  { path: '/accounts/{account_id}/storage/kv/namespaces', label: 'KV namespaces' },
  { path: '/accounts/{account_id}/d1/database', label: 'D1 databases' },
  { path: '/accounts/{account_id}/cfd_tunnel?is_deleted=false', label: 'Tunnels' },
  { path: '/accounts/{account_id}/logpush/jobs', label: 'Account Logpush jobs' },
  { path: '/accounts/{account_id}/alerting/v3/policies', label: 'Notification policies' },
  { path: '/accounts/{account_id}/rulesets', label: 'Account rulesets' },
  { path: '/accounts/{account_id}/access/apps', label: 'Access applications' },
  { path: '/accounts/{account_id}/load_balancers/pools', label: 'Load balancer pools' },
  { path: '/zones?per_page=50', label: 'Zones' },
  { path: '/zones/{zone_id}', label: 'Zone details' },
  { path: '/zones/{zone_id}/dns_records?per_page=100', label: 'DNS records' },
  { path: '/zones/{zone_id}/settings', label: 'Zone settings' },
  { path: '/zones/{zone_id}/rulesets', label: 'Zone rulesets' },
  { path: '/zones/{zone_id}/rulesets/phases/http_request_firewall_custom/entrypoint', label: 'WAF custom rules' },
  { path: '/zones/{zone_id}/ssl/certificate_packs', label: 'Edge certificates' },
  { path: '/zones/{zone_id}/custom_hostnames', label: 'Custom hostnames' },
  { path: '/zones/{zone_id}/page_shield/scripts', label: 'Page Shield scripts' },
  { path: '/zones/{zone_id}/logpush/jobs', label: 'Zone Logpush jobs' },
  { path: '/zones/{zone_id}/healthchecks', label: 'Health checks' },
  { path: '/zones/{zone_id}/workers/routes', label: 'Worker routes' },
  { path: '/ips', label: 'Cloudflare IP ranges' },
];
