import { HttpError, readBody, route } from '@/lib/http';
import { sendTest } from '@/lib/notify';

export const dynamic = 'force-dynamic';

/** Sends one test message to { channel: 'slack' | 'webhook' } (only when someone clicks Send a test). */
export const POST = route(async (req) => {
  const { channel } = await readBody<{ channel?: string }>(req);
  if (channel !== 'slack' && channel !== 'webhook') throw new HttpError(400, 'Unknown channel');
  const r = await sendTest(channel);
  if (!r.ok) throw new HttpError(502, `The test was not delivered: ${r.error}`);
  return { ok: true };
}, { perm: 'monitors:manage', limit: { name: 'monitors-test', max: 5, windowMs: 5 * 60_000 } });
