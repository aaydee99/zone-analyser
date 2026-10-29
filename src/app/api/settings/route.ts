import { readBody, route } from '@/lib/http';
import { getSettings, saveSettings, type Settings } from '@/lib/settings';
import { DEFAULT_OUTPUT_DIR } from '@/lib/store';
import { can } from '@/lib/rbac';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

/** Admins get everything; operators only the output folder, which the New backup form shows as its default. */
export const GET = route(async (_req, _ctx, me) => {
  const settings = await getSettings();
  if (can(me.role, 'settings:read')) return { settings, defaultOutputDir: DEFAULT_OUTPUT_DIR };
  return { settings: { outputDir: settings.outputDir }, defaultOutputDir: DEFAULT_OUTPUT_DIR };
}, { perm: 'runs:start' });

export const PUT = route(async (req, _ctx, me) => {
  const patch = await readBody<Partial<Settings>>(req);
  const before = await getSettings();
  const settings = await saveSettings(patch, me.id);
  // Audit only what actually changed, with its new value.
  const changed = (Object.keys(settings) as (keyof Settings)[]).filter((k) => settings[k] !== before[k]);
  if (changed.length) await audit(me, 'settings.updated', null, Object.fromEntries(changed.map((k) => [k, settings[k]])));
  return { settings };
}, { perm: 'settings:write' });
