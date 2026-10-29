import { readBody, route } from '@/lib/http';
import { listPresets, savePreset } from '@/lib/presets';
import type { BackupConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

export const GET = route(async () => ({ presets: await listPresets() }), { perm: 'runs:read' });

export const POST = route(async (req, _ctx, me) => {
  const { name, config, id } = await readBody<{ name: string; config: BackupConfig; id?: string }>(req);
  return { preset: await savePreset(me, name, config, id) };
}, { perm: 'presets:write' });
