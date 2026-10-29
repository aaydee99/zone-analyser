import { route } from '@/lib/http';
import { cachedActivity } from '@/lib/cf-audit-cache';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Changes from Cloudflare's own audit log, for one stored Cloudflare credential or all of them.
 * ?credentialId=all|<id>&range=day|week|month|year|custom[&since=yyyy-mm-dd&before=yyyy-mm-dd]
 * Cached under this URL for two minutes; &fresh=1 reads it again.
 */
export const GET = route(async (req, _ctx, me) => {
  const report = await cachedActivity(new URL(req.url));
  await audit(me, 'cloudflare_audit.viewed', null, { range: report.range, since: report.since, before: report.before, accounts: report.accounts.length });
  return report;
}, { perm: 'audit:read' });
