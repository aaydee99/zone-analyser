import { readBody, route } from '@/lib/http';
import { activeRunId, listRuns, startRun } from '@/lib/runner';
import { normalizeConfig, type BackupConfig } from '@/lib/config';
import { canApprove, requestBackup } from '@/lib/approvals';
import { listApprovals } from '@/lib/approvals-store';
import { recordFilter, runOwners } from '@/lib/record-access';

export const dynamic = 'force-dynamic';

const PAGE = 200;
const MAX = 5_000;

/**
 * The newest runs this person may see (record-access.ts: their own; admins also operators' and
 * viewers'; super admins all): `?limit=` (200 by default, in steps the page asks for with "Show
 * more"); `more` says older ones exist.
 */
export const GET = route(async (req, _ctx, me) => {
  const asked = Number(new URL(req.url).searchParams.get('limit'));
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX) : PAGE;
  const sees = await recordFilter(me);
  const approvals = listApprovals();
  const visible = (rs: Awaited<ReturnType<typeof listRuns>>) => rs.filter((r) => sees(runOwners(r, approvals)));
  // Others' runs are left out after reading, so read more until the page is full or the runs end.
  let read = limit + 1;
  let all = await listRuns(read);
  let runs = visible(all);
  while (runs.length <= limit && all.length === read && read < MAX * 4) {
    read = Math.min(read * 4, MAX * 4);
    all = await listRuns(read);
    runs = visible(all);
  }
  // Someone else's running backup is not named (starting one is still refused while it runs).
  const active = activeRunId();
  return { runs: runs.slice(0, limit), more: runs.length > limit, activeRunId: active && runs.some((r) => r.id === active) ? active : null };
}, { perm: 'runs:read' });

/** Admins and super admins start a backup; an operator's backup becomes a request an admin approves. */
export const POST = route(async (req, _ctx, me) => {
  const { config, presetName } = await readBody<{ config: Partial<BackupConfig>; presetName?: string }>(req);
  if (!canApprove(me, 'backup')) return { approval: await requestBackup(me, normalizeConfig(config), presetName) };
  return { run: await startRun(me, normalizeConfig(config), presetName) };
}, { perm: 'runs:start' });
