import { route } from '@/lib/http';
import { can } from '@/lib/rbac';
import { getMonitorConfig } from '@/lib/monitor-config';
import { countsOf, coverage, coverageOf, openCounts } from '@/lib/monitor-store';
import { queueView } from '@/lib/monitor-queue';
import { CHECKS, type MonitorOverview } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';

/** Every check the user may see: how much of it was read, its open findings by severity, and the queue. */
export const GET = route(async (_req, _ctx, me) => {
  const visible = CHECKS.filter((c) => can(me.role, c.perm));
  const [cov, open, config, queue] = await Promise.all([coverage(), openCounts(), getMonitorConfig(), queueView()]);
  const overview: MonitorOverview = {
    checks: visible.map((meta) => ({ meta, coverage: coverageOf(cov, meta.id), open: countsOf(open, meta.id), interval: config.intervals[meta.id] })),
    queue, generatedAt: new Date().toISOString(),
  };
  return overview;
}, { perm: 'runs:read' });
