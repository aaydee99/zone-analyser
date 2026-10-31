import { readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { monitorConfigView, saveMonitorConfig, type MonitorConfigPatch } from '@/lib/monitor-config';
import { listNotifications } from '@/lib/monitor-store';

export const dynamic = 'force-dynamic';

/** The schedule and where notifications go (addresses masked), with the notifications sent lately. */
export const GET = route(async () => ({ config: await monitorConfigView(), sent: await listNotifications(30) }), { perm: 'settings:read' });

/** { intervalHours?, minSeverity?, slack?: url | null, webhook?: url | null } — null removes an address. */
export const PUT = route(async (req, _ctx, me) => {
  const p = await readBody<MonitorConfigPatch>(req);
  const config = await saveMonitorConfig(p);
  await audit(me, 'monitoring.settings_updated', null, {
    ...(p.intervalHours !== undefined ? { intervalHours: config.intervalHours } : {}),
    ...(p.minSeverity !== undefined ? { minSeverity: config.minSeverity } : {}),
    ...(p.slack !== undefined ? { slack: p.slack ? 'set' : 'removed' } : {}),
    ...(p.webhook !== undefined ? { webhook: p.webhook ? 'set' : 'removed' } : {}),
  });
  return { config };
}, { perm: 'monitors:manage' });
