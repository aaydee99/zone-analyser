import 'server-only';
import { cached, cacheBackend } from './cache';
import { HttpError } from './http';
import { cloudflareAudit, resolvePeriod } from './cf-audit';
import type { CfAuditReport } from './cf-audit-report';

/** Cloudflare activity for a URL's query, cached under that URL (path and query, without fresh) for two minutes. */
export async function cachedActivity(url: URL): Promise<CfAuditReport> {
  const q = url.searchParams;
  const period = resolvePeriod(q.get('range'), q.get('since'), q.get('before'));
  // One Cloudflare account (accountId), or every account the stored credentials can read.
  const accountId = q.get('accountId') || '';
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) throw new HttpError(400, 'Not a Cloudflare account ID');
  const keep = ['credentialId', 'range', ...(accountId ? ['accountId'] : []), ...(period.range === 'custom' ? ['since', 'before'] : [])];
  const key = new URLSearchParams(keep.map((k) => [k, q.get(k) ?? (k === 'credentialId' ? 'all' : '')] as [string, string]));
  const asked = Date.now();
  const report = await cached(`path:/api/cloudflare-audit?${key}`, 2 * 60_000,
    async () => ({ ...(await cloudflareAudit(q.get('credentialId') || 'all', period, accountId || undefined)), readAt: new Date().toISOString() }), q.get('fresh') === '1');
  return report.readAt && Date.parse(report.readAt) < asked ? { ...report, cachedIn: cacheBackend() } : report;
}
