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

const ghApi = () => (process.env.WORKER_GITHUB_API?.trim() || 'https://api.github.com').replace(/\/$/, '');
const ghWorkflow = () => process.env.WORKER_GITHUB_WORKFLOW?.trim() || 'worker.yml';
const ghHeaders = () => ({
  Authorization: `Bearer ${process.env.WORKER_GITHUB_TOKEN!.trim()}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'backup-console',
});

/** One step of the GitHub Actions run that starts the worker. */
export interface StartStep {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'pending';
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** How far the worker's GitHub Actions run has got (shown while the worker starts). */
export interface StartProgress {
  /** requested: GitHub has not listed the run yet · queued: waiting for a runner · in_progress · completed. */
  status: 'requested' | 'queued' | 'in_progress' | 'completed' | 'waiting';
  conclusion: string | null;
  /** The run's page on GitHub (its live log). */
  url: string | null;
  startedAt: string | null;
  steps: StartStep[];
}

const gp = globalThis as unknown as { __wakeProgress?: { at: number; since: string; value: StartProgress | null } };

type Run = { id: number; status: string; conclusion: string | null; html_url: string; created_at: string; run_started_at?: string };
/** GitHub ends a job after 6 hours: a run listed as still going that is older than that is not. */
const RUN_LIMIT_MS = 6 * 3600_000 + 15 * 60_000;
/** A worker run that is waiting for a runner or running (and young enough to be real). */
const activeRun = (r: Run) => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(r.status) && Date.now() - Date.parse(r.created_at) < RUN_LIMIT_MS;

/**
 * A worker run already queued or in progress on GitHub (one whose worker is still starting, or is
 * finishing its last job): starting another would only queue it behind that one (worker.yml lets
 * the running one finish). null when there is none, or GitHub cannot be asked.
 */
async function runOnItsWay(): Promise<Run | null> {
  try {
    const repo = process.env.WORKER_GITHUB_REPO!.trim();
    const [res, last] = await Promise.all([
      fetch(`${ghApi()}/repos/${repo}/actions/workflows/${encodeURIComponent(ghWorkflow())}/runs?per_page=10`, { headers: ghHeaders(), signal: AbortSignal.timeout(8_000), cache: 'no-store' }),
      db().from('workers').select('started_at').order('last_seen', { ascending: false }).limit(1),
    ]);
    if (!res.ok) return null;
    const body = (await res.json()) as { workflow_runs?: Run[] };
    // A run created before the last worker started is that worker's own run, which is ending (the
    // worker stopped, and GitHub finishes the run a few seconds later): not one on its way.
    const lastStart = Date.parse((last.data as { started_at: string }[] | null)?.[0]?.started_at ?? '') || 0;
    return body.workflow_runs?.find((r) => activeRun(r) && Date.parse(r.created_at) > lastStart) ?? null;
  } catch {
    return null;
  }
}

/** The GitHub Actions run started at or after `since`, with its steps (cached for 4 s). */
export async function startProgress(since: string): Promise<StartProgress | null> {
  if (!wakeConfigured()) return null;
  const hit = gp.__wakeProgress;
  if (hit && hit.since === since && Date.now() - hit.at < 4_000) return hit.value;
  const repo = process.env.WORKER_GITHUB_REPO!.trim();
  const get = async <T>(p: string): Promise<T | null> => {
    const res = await fetch(`${ghApi()}/repos/${repo}${p}`, { headers: ghHeaders(), signal: AbortSignal.timeout(8_000), cache: 'no-store' });
    return res.ok ? ((await res.json()) as T) : null;
  };
  let value: StartProgress | null = null;
  try {
    const runs = await get<{ workflow_runs: Run[] }>(`/actions/workflows/${encodeURIComponent(ghWorkflow())}/runs?event=workflow_dispatch&per_page=5`);
    // The run this request started: created after it (allowing for clock differences); else a run
    // that was already on its way when it was asked (then no new one was started: wakeWorker).
    const run = runs?.workflow_runs?.find((r) => Date.parse(r.created_at) >= Date.parse(since) - 60_000) ?? runs?.workflow_runs?.find(activeRun);
    if (!run) value = { status: 'requested', conclusion: null, url: null, startedAt: null, steps: [] };
    else {
      type Step = { name: string; status: StartStep['status']; conclusion: string | null; started_at: string | null; completed_at: string | null };
      const jobs = await get<{ jobs: { started_at: string | null; steps?: Step[] }[] }>(`/actions/runs/${run.id}/jobs`);
      const job = jobs?.jobs?.[0];
      value = {
        status: (['queued', 'in_progress', 'completed', 'waiting'].includes(run.status) ? run.status : 'queued') as StartProgress['status'],
        conclusion: run.conclusion,
        url: run.html_url,
        startedAt: job?.started_at ?? run.run_started_at ?? null,
        // GitHub's own clean-up steps say nothing about starting the worker.
        steps: (job?.steps ?? []).filter((s) => !/^(Post |Complete job$)/.test(s.name)).map((s) => ({
          // Unnamed steps are listed by GitHub as "Run <command>": shown as the command.
          name: s.name === 'Set up job' ? 'Get a GitHub runner' : s.name.replace(/^Run (?=actions\/|npm |npx |node )/, ''),
          status: s.status, conclusion: s.conclusion, startedAt: s.started_at, completedAt: s.completed_at,
        })),
      };
    }
  } catch {
    value = hit?.since === since ? hit.value : null;
  }
  gp.__wakeProgress = { at: Date.now(), since, value };
  return value;
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

  // A run is already queued or running (still building, or its worker finishing a job before it
  // stops): no second one. The start request stays recorded, so callers wait for that run.
  const onItsWay = await runOnItsWay();
  if (onItsWay) {
    console.log(`[worker] not starting another worker: run ${onItsWay.id} is ${onItsWay.status.replace('_', ' ')} on GitHub Actions`);
    return { result: 'already' };
  }

  const repo = process.env.WORKER_GITHUB_REPO!.trim();
  let message = '';
  try {
    const res = await fetch(`${ghApi()}/repos/${repo}/actions/workflows/${encodeURIComponent(ghWorkflow())}/dispatches`, {
      method: 'POST',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
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
