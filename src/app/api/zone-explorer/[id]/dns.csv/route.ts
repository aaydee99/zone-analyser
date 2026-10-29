import { HttpError, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { zoneGroup } from '@/lib/zone-explorer';
import { csvFile, dnsRows } from '@/lib/zone-format';
import { attachment, zoneIdOf } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** The DNS records as CSV (from the cached DNS section). */
export const GET = route<Ctx>(async (_req, { params }, me) => {
  const dns = await zoneGroup(await zoneIdOf(params), 'dns');
  const records = dns.sections.find((s) => s.key === 'dns_records');
  if (!Array.isArray(records?.data)) throw new HttpError(records?.status === 'unavailable' ? 403 : 404, records?.message ?? 'No DNS records could be read');
  await audit(me, 'cloudflare_zone.exported', dns.zoneName, { zoneId: dns.zoneId, format: 'dns-csv' });
  return attachment(`${dns.zoneName}-${dns.generatedAt.slice(0, 10)}-dns.csv`, csvFile(dnsRows(records.data as Record<string, unknown>[])), 'text/csv; charset=utf-8');
}, { perm: 'runs:read', limit: { name: 'zone-export', max: 20 } });
