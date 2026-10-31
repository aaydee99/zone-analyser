import { route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { indexStatus, rebuildIndex } from '@/lib/zone-search';

export const dynamic = 'force-dynamic';

/** What the search index holds per source, and the rebuild running on the worker (if any). */
export const GET = route(async () => indexStatus(), { perm: 'runs:read' });

/** Rebuilds the index in the background from stored data (drift snapshots, monitoring rows, each zone's newest backup). */
export const POST = route(async (_req, _ctx, me) => {
  const { job, started } = rebuildIndex(me.email);
  if (started) await audit(me, 'search.index_rebuilt', null, { startedAt: job.startedAt });
  return { rebuild: job, started, status: await indexStatus() };
}, { perm: 'monitors:manage', limit: { name: 'search-rebuild', max: 5, windowMs: 10 * 60_000 } });
