import 'server-only';
import { db } from './supabase';

// Starting the worker on demand (web side). When the worker runs on GitHub Actions it is not
// always on: the web side starts the "Console worker" workflow when someone needs it, and the
// worker stops itself when idle (CONSOLE_WORKER_IDLE_MINUTES).
//
//   WORKER_GITHUB_TOKEN     fine-grained token for the repository, permission Actions: Read and write
//   WORKER_GITHUB_REPO      owner/name, e.g. aaydee99/zone-analyser
//   WORKER_GITHUB_WORKFLOW  the workflow file (default worker.yml)
//   WORKER_GITHUB_REF       the branch to run it from (default main)

/** A start request this recent is still on its way: not asked again (a runner takes 2–3 minutes). */
export const WAKE_WINDOW_MS = 6 * 60_000;

export const wakeConfigured = () => !!(process.env.WORKER_GITHUB_TOKEN?.trim() && process.env.WORKER_GITHUB_REPO?.trim());

/** When the worker was last asked to start, if that is recent enough that it may still be starting. */
export async function startingSince(): Promise<string | null> {
  if (!wakeConfigured()) return null;
  const { data } = await db().from('worker_wakeups').select('requested_at, result').eq('id', 1).maybeSingle();
  const row = data as { requested_at: string; result: string | null } | null;
  return row && row.result === 'started' && Date.now() - Date.parse(row.requested_at) < WAKE_WINDOW_MS ? row.requested_at : null;
}

/**
 * Asks GitHub to start the worker, unless that was asked within the last few minutes.
 * Returns 'started', 'already' (a start is on its way) or 'unavailable' (not configured, or GitHub refused).
 */
export async function wakeWorker(by: string): Promise<{ result: 'started' | 'already' | 'unavailable'; message?: string }> {
  if (!wakeConfigured()) return { result: 'unavailable', message: 'Starting the worker on demand is not set up (WORKER_GITHUB_TOKEN, WORKER_GITHUB_REPO)' };
  if (await startingSince()) return { result: 'already' };
  // Claim the request: only one of several simultaneous callers sees its own timestamp come back.
  const at = new Date().toISOString();
  const prev = (await db().from('worker_wakeups').select('requested_at').eq('id', 1).maybeSingle()).data as { requested_at: string } | null;
  const claim = prev
    ? await db().from('worker_wakeups').update({ requested_at: at, requested_by: by, result: 'started' }).eq('id', 1).eq('requested_at', prev.requested_at).select('requested_at')
    : await db().from('worker_wakeups').insert({ id: 1, requested_at: at, requested_by: by, result: 'started' }).select('requested_at');
  if (claim.error || !(claim.data as unknown[] | null)?.length) return { result: 'already' };

  const repo = process.env.WORKER_GITHUB_REPO!.trim();
  const workflow = process.env.WORKER_GITHUB_WORKFLOW?.trim() || 'worker.yml';
  const api = (process.env.WORKER_GITHUB_API?.trim() || 'https://api.github.com').replace(/\/$/, '');
  let message = '';
  try {
    const res = await fetch(`${api}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WORKER_GITHUB_TOKEN!.trim()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'backup-console',
      },
      body: JSON.stringify({ ref: process.env.WORKER_GITHUB_REF?.trim() || 'main' }),
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    if (res.status === 204) return { result: 'started' };
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    message = `GitHub answered ${res.status}${body?.message ? `: ${body.message}` : ''}`;
  } catch (err) {
    message = `GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}`;
  }
  await db().from('worker_wakeups').update({ result: message.slice(0, 300) }).eq('id', 1).eq('requested_at', at);
  console.error(`[worker] could not start the worker: ${message}`);
  return { result: 'unavailable', message };
}
