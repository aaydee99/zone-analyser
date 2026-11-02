import 'server-only';
import { activeRunId, getRun } from './runner';
import { recordFilter, runOwners } from './record-access';
import { listApprovals } from './approvals-store';
import { activeRestore, type ActiveRestore } from './job-lock';
import { pendingFor } from './approvals';
import { isWebRole, latestWorker, relayJson, retireIfOutdated } from './worker-link';
import { startProgress, startingSince, wakeConfigured, wakeWorker, type StartProgress } from './worker-wake';
import type { Me } from './auth';

/** Shown in the shell and on Settings when a worker runs the jobs (web role). */
export interface WorkerSummary {
  online: boolean;
  /** Being started on GitHub Actions (since then); null when not. */
  startingSince: string | null;
  /** The GitHub Actions run starting it, step by step (while starting). */
  start: StartProgress | null;
  /** Whether the web side can start it (GitHub Actions set up). */
  onDemand: boolean;
  /** Runs older code: it stops once nothing is running, and a new one starts. */
  updating: boolean;
  /** 'github-actions' when it runs on GitHub Actions (no fixed outgoing IP). */
  id: string | null;
  hostname: string | null;
  publicIp: string | null;
  lastSeen: string | null;
  tools: { name: string; version: string | null }[] | null;
}

export interface LiveState {
  activeRunId: string | null;
  activeRestore: ActiveRestore | null;
  pendingApprovals: number;
  /** Only on the web role (Vercel): the worker that runs the jobs. */
  worker?: WorkerSummary;
}

/**
 * The running backup and restore as `me` may see them (record-access.ts): someone else's running
 * backup is not named (null), and someone else's restore is shown without its zone, person or id —
 * a job is running (so a new one waits), but whose and where stays theirs.
 */
async function visibleJobs(me: Me): Promise<Pick<LiveState, 'activeRunId' | 'activeRestore'>> {
  const runId = activeRunId();
  const restore = activeRestore();
  if (!runId && !restore) return { activeRunId: null, activeRestore: null };
  const sees = await recordFilter(me);
  const run = runId ? await getRun(runId).catch(() => null) : null;
  return {
    activeRunId: runId && run && sees(runOwners(run, listApprovals())) ? runId : null,
    activeRestore: restore && !sees([restore.by]) ? { ...restore, id: '', zone: '', by: '' } : restore,
  };
}

/**
 * The running job and the approvals waiting for `me`. On Vercel these live on the worker, so it
 * is asked (briefly: the page must not hang when the worker is offline).
 */
/** `wake`: start the worker when none is online (false for the background status poll). */
export async function liveState(me: Me, wake = true): Promise<LiveState> {
  if (!isWebRole()) return { ...(await visibleJobs(me)), pendingApprovals: pendingFor(me) };
  const w = await latestWorker().catch(() => null);
  const s = w?.online ? await relayJson<LiveState>(me, '/api/auth/me?peek=1', 4_000) : null;
  const updating = w?.online ? await retireIfOutdated(w).catch(() => false) : false;
  // Someone opened the console and no worker runs: start one now, so it is ready by the time it is needed.
  // Only when no worker's heartbeat is current, and not for the background poll: after an idle stop
  // the worker starts again when someone uses the console, not because a tab is open.
  if (wake && !w?.online && wakeConfigured()) await wakeWorker(me.email).catch(() => null);
  const starting = !s && wakeConfigured() ? await startingSince().catch(() => null) : null;
  const start = starting ? await startProgress(starting).catch(() => null) : null;
  return {
    activeRunId: s?.activeRunId ?? null,
    activeRestore: s?.activeRestore ?? null,
    pendingApprovals: s?.pendingApprovals ?? 0,
    worker: { online: !!w?.online && !!s, startingSince: starting, start, updating, onDemand: wakeConfigured(), id: w?.id ?? null, hostname: w?.hostname ?? null, publicIp: w?.publicIp ?? null, lastSeen: w?.lastSeen ?? null, tools: w?.tools ?? null },
  };
}
