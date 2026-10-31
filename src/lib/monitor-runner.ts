import 'server-only';
import type { Progress } from './bg-job';
import { audit, type Actor } from './audit';
import { getMonitorConfig, setLastRun } from './monitor-config';
import { saveReport, syncFindings } from './monitor-store';
import { CHECKS, type CheckId, type Finding } from './monitor-types';
import { notifyFindings } from './notify';
import { makeContext, type CheckRunner } from './checks/common';
import { posture } from './checks/posture';
import { certificates } from './checks/certificates';
import { governance } from './checks/governance';
import { drift } from './checks/drift';
import { alerts } from './checks/alerts';
import { availability } from './checks/availability';
import { platform } from './checks/platform';
import { appsec } from './checks/appsec';
import { pagerules } from './checks/pagerules';

// Runs the monitoring checks: one at a time (they share each token's rate budget), each result saved
// as soon as it is ready, then one notification for everything new. On the worker, runDue() is
// called every few minutes and starts a full run when the schedule says one is due.

const RUNNERS: Record<CheckId, CheckRunner> = { posture, certificates, governance, drift, alerts, availability, platform, appsec, pagerules };

export interface RunState {
  running: boolean;
  startedAt: string | null;
  by: string | null;
  checks: CheckId[];
  current: { check: CheckId; done: number; total: number } | null;
  finishedAt: string | null;
  lastError: string | null;
}

const g = globalThis as unknown as { __monitorRun?: RunState };
const state = (g.__monitorRun ??= { running: false, startedAt: null, by: null, checks: [], current: null, finishedAt: null, lastError: null });

export const runState = (): RunState => ({ ...state, checks: [...state.checks], current: state.current ? { ...state.current } : null });

async function runAll(ids: CheckId[], actor: Actor | null, by: string) {
  const progress: Progress = { done: 0, total: 0 };
  const ctx = makeContext(progress);
  const fresh: Finding[] = [];
  let failed = 0;
  for (const id of ids) {
    progress.done = 0; progress.total = 0;
    state.current = { check: id, done: 0, total: 0 };
    const tick = setInterval(() => { if (state.current) Object.assign(state.current, { done: progress.done, total: progress.total }); }, 500);
    try {
      const r = await RUNNERS[id](ctx);
      await saveReport(id, r.report, null);
      fresh.push(...await syncFindings(id, r.findings, r.read));
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[monitoring] ${id} failed:`, message);
      await saveReport(id, null, message).catch(() => {});
    } finally {
      clearInterval(tick);
    }
  }
  state.current = null;
  if (ids.length === CHECKS.length) await setLastRun(new Date().toISOString()).catch(() => {});
  let sent = 0;
  try { sent = await notifyFindings(fresh); } catch (err) { console.error('[monitoring] notification failed:', err instanceof Error ? err.message : err); }
  await audit(actor, 'monitoring.ran', null, { checks: ids, by, newFindings: fresh.length, notified: sent, failed }).catch(() => {});
}

/** Starts a run in the background. Returns false when one is already running. */
export function startRun(ids: CheckId[], actor: Actor | null, by: string): boolean {
  if (state.running) return false;
  Object.assign(state, { running: true, startedAt: new Date().toISOString(), by, checks: ids, current: null, finishedAt: null, lastError: null });
  void runAll(ids, actor, by)
    .catch((err) => { state.lastError = err instanceof Error ? err.message : String(err); })
    .finally(() => { Object.assign(state, { running: false, current: null, finishedAt: new Date().toISOString() }); });
  return true;
}

/** Called by the worker loop: a full run when the schedule says one is due. */
export async function runDue(): Promise<boolean> {
  if (state.running) return false;
  const c = await getMonitorConfig();
  if (!c.intervalHours) return false;
  const last = c.lastRunAt ? Date.parse(c.lastRunAt) : 0;
  if (Date.now() - last < c.intervalHours * 3_600_000) return false;
  return startRun(CHECKS.map((x) => x.id), null, 'schedule');
}
