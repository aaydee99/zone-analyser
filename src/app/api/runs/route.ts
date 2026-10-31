import { readBody, route } from '@/lib/http';
import { activeRunId, listRuns, startRun } from '@/lib/runner';
import { normalizeConfig, type BackupConfig } from '@/lib/config';
import { canApprove, requestBackup } from '@/lib/approvals';
import { requestNote } from '@/lib/approvals-store';

export const dynamic = 'force-dynamic';

const PAGE = 200;
const MAX = 5_000;

/** The newest runs: `?limit=` (200 by default, in steps the page asks for with "Show more"); `more` says older ones exist. */
export const GET = route(async (req) => {
  const asked = Number(new URL(req.url).searchParams.get('limit'));
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX) : PAGE;
  const runs = await listRuns(limit + 1);
  return { runs: runs.slice(0, limit), more: runs.length > limit, activeRunId: activeRunId() };
}, { perm: 'runs:read' });

/** Admins and super admins start a backup; an operator's backup becomes a request an admin approves. */
export const POST = route(async (req, _ctx, me) => {
  const body = await readBody<{ config: Partial<BackupConfig>; presetName?: string; reason?: string; ticket?: string }>(req);
  const { config, presetName } = body;
  // An operator's request carries its reason and ticket (src/lib/change-note.ts) to the approver.
  if (!canApprove(me, 'backup')) return { approval: await requestBackup(me, normalizeConfig(config), presetName, await requestNote(body)) };
  return { run: await startRun(me, normalizeConfig(config), presetName) };
}, { perm: 'runs:start' });
