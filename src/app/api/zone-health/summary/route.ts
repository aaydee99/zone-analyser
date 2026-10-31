import { route } from '@/lib/http';
import { healthPage, healthSummary } from '@/lib/zone-health';

export const dynamic = 'force-dynamic';

/** The Overview card: the estate's average score, the zones in each band, and the five worst. */
export const GET = route(async () => {
  const [summary, worst] = await Promise.all([healthSummary(), healthPage({ sort: 'score', limit: 5 })]);
  return { summary, worst: worst.rows.map((r) => ({ zoneId: r.zoneId, zoneName: r.zoneName, score: r.score })), generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });
