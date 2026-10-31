import { route } from '@/lib/http';
import { can } from '@/lib/rbac';
import { getMonitorConfig } from '@/lib/monitor-config';
import { listFindings, readAllReports } from '@/lib/monitor-store';
import { runState } from '@/lib/monitor-runner';
import { CHECKS, SEVERITIES, isCheckId, type MonitorOverview, type Severity } from '@/lib/monitor-types';

export const dynamic = 'force-dynamic';

/** Every check the user may see: when it last ran, its open findings by severity, and the schedule. */
export const GET = route(async (_req, _ctx, me) => {
  const visible = CHECKS.filter((c) => can(me.role, c.perm));
  const ids = new Set(visible.map((c) => c.id));
  const [reports, open, config] = await Promise.all([readAllReports(), listFindings(), getMonitorConfig()]);
  const findings = open.filter((f) => ids.has(f.check));
  const byCheck = new Map(reports.filter((r) => isCheckId(r.check)).map((r) => [r.check, r]));
  const zero = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const state = runState();
  const next = config.intervalHours ? new Date((config.lastRunAt ? Date.parse(config.lastRunAt) : Date.now()) + config.intervalHours * 3_600_000).toISOString() : null;
  const overview: MonitorOverview & { run: typeof state } = {
    checks: visible.map((meta) => {
      const r = byCheck.get(meta.id);
      const counts = zero();
      for (const f of findings) if (f.check === meta.id && !f.dismissedAt) counts[f.severity]++;
      return { meta, ranAt: r?.ranAt ?? null, error: r?.error ?? null, open: counts, partial: !!r?.partial };
    }),
    findings: findings.slice(0, 500),
    schedule: { intervalHours: config.intervalHours, lastRunAt: config.lastRunAt, nextRunAt: next, running: state.running },
    run: state,
  };
  return overview;
}, { perm: 'runs:read' });
