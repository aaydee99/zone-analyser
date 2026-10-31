import { route } from '@/lib/http';
import { getMonitorConfig } from '@/lib/monitor-config';
import { knownAccounts } from '@/lib/report-store';

export const dynamic = 'force-dynamic';

/** What a report can cover and where it can go: the accounts monitoring knows, the zone tags, and which channels are set up. */
export const GET = route(async () => {
  const [accounts, cfg] = await Promise.all([knownAccounts(), getMonitorConfig()]);
  let tags: { tag: string; count: number }[] = [];
  try {
    const m = (await import('@/lib/zone-meta')) as { allTags?: () => Promise<{ tag: string; count: number }[]> };
    if (m.allTags) tags = (await m.allTags()).slice(0, 500);
  } catch { /* zone tags not set up: typed in by hand */ }
  return { accounts, tags, channels: { slack: !!cfg.slack, webhook: !!cfg.webhook }, generatedAt: new Date().toISOString() };
}, { perm: 'runs:read' });
