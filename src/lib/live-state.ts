import 'server-only';
import { activeRunId } from './runner';
import { activeRestore, type ActiveRestore } from './job-lock';
import { pendingFor } from './approvals';
import { isWebRole, latestWorker, relayJson } from './worker-link';
import type { Me } from './auth';

/** Shown in the shell and on Settings when a worker runs the jobs (web role). */
export interface WorkerSummary {
  online: boolean;
  /** 'cloudflare-container' on Cloudflare Containers (no fixed outgoing IP). */
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
 * The running job and the approvals waiting for `me`. On Vercel these live on the worker, so it
 * is asked (briefly: the page must not hang when the worker is offline).
 */
export async function liveState(me: Me): Promise<LiveState> {
  if (!isWebRole()) return { activeRunId: activeRunId(), activeRestore: activeRestore(), pendingApprovals: pendingFor(me) };
  const w = await latestWorker().catch(() => null);
  const s = w?.online ? await relayJson<LiveState>(me, '/api/auth/me?peek=1', 4_000) : null;
  return {
    activeRunId: s?.activeRunId ?? null,
    activeRestore: s?.activeRestore ?? null,
    pendingApprovals: s?.pendingApprovals ?? 0,
    worker: { online: !!w?.online && !!s, id: w?.id ?? null, hostname: w?.hostname ?? null, publicIp: w?.publicIp ?? null, lastSeen: w?.lastSeen ?? null, tools: w?.tools ?? null },
  };
}
