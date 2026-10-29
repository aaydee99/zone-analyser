import 'server-only';
import { cached, cacheBackend } from './cache';
import { cloudflareAudit, resolvePeriod } from './cf-audit';
import type { CfAuditReport } from './cf-audit-report';

/** Cloudflare activity for a URL's query, cached under that URL (path and query, without fresh) for two minutes. */
export async function cachedActivity(url: URL): Promise<CfAuditReport> {
  const q = url.searchParams;
  const period = resolvePeriod(q.get('range'), q.get('since'), q.get('before'));
  const keep = ['credentialId', 'range', ...(period.range === 'custom' ? ['since', 'before'] : [])];
  const key = new URLSearchParams(keep.map((k) => [k, q.get(k) ?? (k === 'credentialId' ? 'all' : '')] as [string, string]));
  const asked = Date.now();
  const report = await cached(`path:/api/cloudflare-audit?${key}`, 2 * 60_000,
    async () => ({ ...(await cloudflareAudit(q.get('credentialId') || 'all', period)), readAt: new Date().toISOString() }), q.get('fresh') === '1');
  return report.readAt && Date.parse(report.readAt) < asked ? { ...report, cachedIn: cacheBackend() } : report;
}
