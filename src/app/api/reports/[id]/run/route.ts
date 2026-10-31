import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { getDefinition } from '@/lib/report-store';
import { runNow } from '@/lib/report-scheduler';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/**
 * Makes the report now (on the worker), for the period up to now: { deliver?: boolean } also sends it
 * to its channels (once). Answers at once with the run; the history shows it when it is ready.
 */
export const POST = route<Ctx>(async (req, { params }, me) => {
  const d = await getDefinition((await params).id);
  if (!d) throw new HttpError(404, 'Report not found');
  const { deliver } = await readBody<{ deliver?: boolean }>(req);
  if (deliver !== undefined && typeof deliver !== 'boolean') throw new HttpError(400, 'deliver must be true or false');
  if (deliver && !d.channels.length) throw new HttpError(400, 'This report has no channel to send to — choose Slack or the webhook first');
  const run = await runNow(d, me.email, !!deliver);
  if (!run) throw new HttpError(409, 'This report is being made right now — wait for it to finish');
  await audit(me, 'report.generated', d.name, { id: d.id, run: run.id, deliver: !!deliver, channels: deliver ? d.channels : [] });
  return { run };
}, { perm: 'monitors:manage', limit: { name: 'report-run', max: 10 } });
