import { readBody, route } from '@/lib/http';
import { activeRunId, listRuns, startRun } from '@/lib/runner';
import { normalizeConfig, type BackupConfig } from '@/lib/config';
import { canApprove, requestBackup } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

export const GET = route(async () => ({ runs: await listRuns(), activeRunId: activeRunId() }), { perm: 'runs:read' });

/** Admins and super admins start a backup; an operator's backup becomes a request an admin approves. */
export const POST = route(async (req, _ctx, me) => {
  const { config, presetName } = await readBody<{ config: Partial<BackupConfig>; presetName?: string }>(req);
  if (!canApprove(me, 'backup')) return { approval: await requestBackup(me, normalizeConfig(config), presetName) };
  return { run: await startRun(me, normalizeConfig(config), presetName) };
}, { perm: 'runs:start' });
