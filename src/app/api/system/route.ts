import { route } from '@/lib/http';
import { systemCheck } from '@/lib/runner';
import { can } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

type Check = { ok: boolean; detail: string };
/** Version and source, without the install path ("v1.9.0 · console-managed · C:\…" → "v1.9.0 · console-managed"). */
const noPath = (c: Check): Check => ({ ok: c.ok, detail: c.detail.split(' · ').slice(0, 2).join(' · ') });

/** Admins get the full check (paths, PATH sources, platform). Everyone else gets pass/fail for the overview card only. */
export const GET = route(async (_req, _ctx, me) => {
  const check = await systemCheck();
  if (can(me.role, 'settings:read')) return { check };
  return {
    check: {
      node: check.node,
      terraform: noPath(check.terraform),
      cfTerraforming: noPath(check.cfTerraforming),
      script: { ok: check.script.ok, detail: '' },
      envOverride: { ok: check.envOverride.ok, detail: '' },
    },
  };
}, { perm: 'runs:read' });
