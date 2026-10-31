// DNS hygiene: pure helpers for the `dns` monitoring check (src/lib/checks/dns.ts) and the onboarding
// page. No Node or network imports, so they are unit-tested directly (tests/dns-hygiene.test.ts).

/**
 * Services a CNAME can point at where someone else can claim the name once its owner deletes the
 * resource. `nxdomain`: the provider's name stops resolving when the resource is gone, so NXDOMAIN
 * is a strong sign it can be taken over. `http`: the name keeps resolving (the provider answers
 * for every name) and only an HTTP request would tell — the console does not send one, so these
 * are listed for review, not reported as dangling unless they do not resolve at all.
 * Sources: the public "can-i-take-over-xyz" research and each provider's custom-domain docs.
 */
export const TAKEOVER_SERVICES: { suffix: string; service: string; mode: 'nxdomain' | 'http' }[] = [
  // Microsoft Azure: a deleted app, cloud service, Traffic Manager profile or storage account frees its name.
  { suffix: '.azurewebsites.net', service: 'Azure App Service', mode: 'nxdomain' },
  { suffix: '.cloudapp.net', service: 'Azure Cloud Services', mode: 'nxdomain' },
  { suffix: '.cloudapp.azure.com', service: 'Azure VM / public IP', mode: 'nxdomain' },
  { suffix: '.trafficmanager.net', service: 'Azure Traffic Manager', mode: 'nxdomain' },
  { suffix: '.blob.core.windows.net', service: 'Azure Blob Storage', mode: 'nxdomain' },
  { suffix: '.azureedge.net', service: 'Azure CDN', mode: 'nxdomain' },
  { suffix: '.azure-api.net', service: 'Azure API Management', mode: 'nxdomain' },
  { suffix: '.azurecontainer.io', service: 'Azure Container Instances', mode: 'nxdomain' },
  { suffix: '.azurestaticapps.net', service: 'Azure Static Web Apps', mode: 'nxdomain' },
  { suffix: '.azurefd.net', service: 'Azure Front Door', mode: 'nxdomain' },
  // AWS.
  { suffix: '.elasticbeanstalk.com', service: 'AWS Elastic Beanstalk', mode: 'nxdomain' },
  { suffix: '.s3-website', service: 'AWS S3 website', mode: 'http' },
  { suffix: '.s3.amazonaws.com', service: 'AWS S3', mode: 'http' },
  { suffix: '.cloudfront.net', service: 'AWS CloudFront', mode: 'http' },
  // Hosting and CDNs that answer for every name.
  { suffix: '.herokuapp.com', service: 'Heroku', mode: 'http' },
  { suffix: '.herokudns.com', service: 'Heroku', mode: 'nxdomain' },
  { suffix: '.github.io', service: 'GitHub Pages', mode: 'http' },
  { suffix: '.fastly.net', service: 'Fastly', mode: 'http' },
  { suffix: '.myshopify.com', service: 'Shopify', mode: 'http' },
  { suffix: '.netlify.app', service: 'Netlify', mode: 'http' },
  { suffix: '.netlify.com', service: 'Netlify', mode: 'http' },
  { suffix: '.vercel.app', service: 'Vercel', mode: 'http' },
  { suffix: '.now.sh', service: 'Vercel', mode: 'http' },
  { suffix: '.pantheonsite.io', service: 'Pantheon', mode: 'http' },
  { suffix: '.ghost.io', service: 'Ghost', mode: 'http' },
  { suffix: '.zendesk.com', service: 'Zendesk', mode: 'http' },
  { suffix: '.helpscoutdocs.com', service: 'Help Scout', mode: 'http' },
  { suffix: '.readthedocs.io', service: 'Read the Docs', mode: 'http' },
  { suffix: '.surge.sh', service: 'Surge', mode: 'http' },
  { suffix: '.bitbucket.io', service: 'Bitbucket', mode: 'http' },
  { suffix: '.wordpress.com', service: 'WordPress.com', mode: 'http' },
  { suffix: '.wpengine.com', service: 'WP Engine', mode: 'http' },
  { suffix: '.unbouncepages.com', service: 'Unbounce', mode: 'http' },
  { suffix: '.webflow.io', service: 'Webflow', mode: 'http' },
  { suffix: '.fly.dev', service: 'Fly.io', mode: 'http' },
  { suffix: '.onrender.com', service: 'Render', mode: 'http' },
  { suffix: '.pages.dev', service: 'Cloudflare Pages', mode: 'http' },
  { suffix: '.workers.dev', service: 'Cloudflare Workers', mode: 'http' },
];

const lower = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');

/** The takeover-prone service a CNAME target is on, or null. */
export function takeoverService(target: string): { service: string; mode: 'nxdomain' | 'http' } | null {
  const t = `.${lower(target)}`;
  for (const s of TAKEOVER_SERVICES) {
    // ".s3-website" matches s3-website-us-east-1.amazonaws.com and s3-website.eu-west-1.amazonaws.com.
    if (s.suffix === '.s3-website' ? /\.s3-website[.-][a-z0-9-]+(\.[a-z0-9-]+)*\.amazonaws\.com$/.test(t) : t.endsWith(s.suffix)) return { service: s.service, mode: s.mode };
  }
  return null;
}

/** Whether `name` is `zone` or below it. */
export const inZone = (name: string, zone: string) => { const n = lower(name), z = lower(zone); return n === z || n.endsWith(`.${z}`); };

export interface DnsRecord { name: string; type: string; content: string; proxied?: boolean; proxiable?: boolean; ttl?: number }

/** Private, loopback, link-local and documentation-free addresses that say nothing about an origin on the internet. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (v.includes(':')) return v === '::1' || v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd') || v === '::';
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

export interface OriginLeak {
  /** The unproxied record that shows the address or target. */
  record: DnsRecord;
  /** A proxied record it gives away. */
  proxied: DnsRecord;
  why: 'same-name' | 'same-ip' | 'same-target';
}

/**
 * Unproxied records that reveal what proxied ones hide: an unproxied A/AAAA/CNAME on a name that
 * also has a proxied record, or with the same address (or CNAME target) as a proxied record.
 * One leak per unproxied record (the strongest reason).
 */
export function originLeaks(records: DnsRecord[]): OriginLeak[] {
  const web = records.filter((r) => r.type === 'A' || r.type === 'AAAA' || r.type === 'CNAME');
  const proxied = web.filter((r) => r.proxied);
  if (!proxied.length) return [];
  const byName = new Map<string, DnsRecord>();
  const byValue = new Map<string, DnsRecord>();
  for (const r of proxied) {
    if (!byName.has(lower(r.name))) byName.set(lower(r.name), r);
    const k = `${r.type === 'CNAME' ? 'CNAME' : 'IP'}:${lower(r.content)}`;
    if (!byValue.has(k)) byValue.set(k, r);
  }
  const out: OriginLeak[] = [];
  for (const r of web) {
    if (r.proxied || (r.type !== 'CNAME' && isPrivateIp(r.content))) continue;
    const sibling = byName.get(lower(r.name));
    if (sibling) { out.push({ record: r, proxied: sibling, why: 'same-name' }); continue; }
    const same = byValue.get(`${r.type === 'CNAME' ? 'CNAME' : 'IP'}:${lower(r.content)}`);
    if (same) out.push({ record: r, proxied: same, why: r.type === 'CNAME' ? 'same-target' : 'same-ip' });
  }
  return out;
}

/** Nameservers as a sorted, lower-case set without trailing dots. */
export const nsSet = (list: string[]) => [...new Set(list.map(lower).filter(Boolean))].sort();

export type Delegation = 'ok' | 'missing' | 'extra' | 'elsewhere' | 'unknown';

/**
 * How the nameservers seen in public DNS compare with the ones Cloudflare assigned: `ok` the same,
 * `missing` some assigned ones are not delegated, `extra` other nameservers are delegated next to
 * Cloudflare's, `elsewhere` none of Cloudflare's, `unknown` nothing was seen.
 */
export function compareDelegation(assigned: string[], seen: string[]): { state: Delegation; missing: string[]; extra: string[] } {
  const a = nsSet(assigned), s = nsSet(seen);
  if (!s.length || !a.length) return { state: 'unknown', missing: [], extra: [] };
  const missing = a.filter((x) => !s.includes(x));
  const extra = s.filter((x) => !a.includes(x));
  const state: Delegation = missing.length === a.length ? 'elsewhere' : extra.length ? 'extra' : missing.length ? 'missing' : 'ok';
  return { state, missing, extra };
}

/** The key tags of DS records in DoH presentation format ("2371 13 2 ABCD…"). */
export const dsKeyTags = (ds: string[]) => [...new Set(ds.map((d) => Number(d.trim().split(/\s+/)[0])).filter((n) => Number.isInteger(n) && n >= 0))];

export type DnssecState = 'ok' | 'off' | 'broken-disabled' | 'mismatch' | 'no-ds' | 'pending' | 'unknown';

/**
 * Cloudflare's DNSSEC status for the zone against the DS records at the parent.
 * `broken-disabled`: the registrar still publishes DS but Cloudflare no longer signs — validating
 * resolvers fail the whole zone. `mismatch`: DS present but none matches Cloudflare's key.
 * `no-ds`: signing, but the registrar has no DS, so nothing is protected.
 */
export function compareDnssec(status: string | null, keyTag: number | null, ds: string[] | null): DnssecState {
  if (status === null || ds === null) return 'unknown';
  const tags = dsKeyTags(ds);
  const signing = status === 'active' || status === 'pending' || status === 'pending-disabled';
  if (!signing) return tags.length ? 'broken-disabled' : 'off';
  if (!tags.length) return status === 'pending' ? 'pending' : 'no-ds';
  if (keyTag !== null && !tags.includes(keyTag)) return 'mismatch';
  return 'ok';
}
