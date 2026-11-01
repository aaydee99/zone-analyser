import 'server-only';
import { tokenForZone } from '../account-token';
import { HttpError } from '../http';
import { auditZone } from './read';
import { finishAudit, getAudit, startAudit } from './store';

// Runs one audit in the background on the worker (route() relays the start from the web role): the
// start answers once the audit is done or after WAIT_MS, whichever is first; the page then asks for
// the stored audit every few seconds while it runs, and stops. At most MAX_RUNNING audits run at once
// per worker, each stopped after RUN_LIMIT_MS (its row then says so).

const WAIT_MS = 8_000;
export const MAX_RUNNING = 3;
const RUN_LIMIT_MS = 10 * 60_000;

const g = globalThis as unknown as { __zoneAudits?: Set<string> };
const running = (g.__zoneAudits ??= new Set());

export async function runAudit(zoneId: string, hours: number, by: string | null) {
  if (running.size >= MAX_RUNNING) throw new HttpError(429, `${MAX_RUNNING} audits are running already — try again in a minute`, { 'Retry-After': '60' });
  const z = await tokenForZone(zoneId);
  const row = await startAudit({ zoneId, zoneName: z.zoneName, accountId: z.accountId }, by, hours);
  if (!row) throw new HttpError(409, 'An audit of this zone is running — wait for it to finish');
  running.add(row.id);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error('The audit took longer than 10 minutes and was stopped')), RUN_LIMIT_MS);
  timer.unref?.();
  const done = auditZone({ token: z.token, zoneId, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName, hours, signal: stop.signal })
    .then((report) => finishAudit(row.id, { report }))
    .catch((err) => finishAudit(row.id, { error: stop.signal.aborted ? String((stop.signal.reason as Error)?.message ?? 'Stopped') : err instanceof Error ? err.message : String(err) }).catch(() => {}))
    .finally(() => { clearTimeout(timer); running.delete(row.id); });
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, WAIT_MS).unref?.())]);
  return (await getAudit(row.id).then((a) => (a ? { ...a, report: null } : null))) ?? row;
}
