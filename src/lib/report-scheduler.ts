import 'server-only';
import crypto from 'node:crypto';
import { BRAND } from './brand';
import { consoleRole } from './worker-link';
import { sendReport } from './notify';
import { buildReport } from './report-build';
import { slackMessage, webhookMessage } from './report-render';
import { claimDelivery, claimDue, dueDefinitions, failStale, finishRun, knownAccounts, saveDelivery, startManual } from './report-store';
import type { ReportDefinition, ReportRunSummary } from './report-types';

// Scheduled reports, made by the worker (started from src/lib/worker-loop.ts). Every minute it looks
// for reports whose time has come; each is taken with one conditional update (report_claim), so of
// several workers only one makes it. The report then goes to each of its channels once: the channel
// is claimed before sending (report_claim_delivery), and a failed send is recorded, not retried — a
// report is never sent twice. A worker that stops halfway leaves the run "running"; it is marked
// failed after 30 minutes and not made again (the next scheduled one comes at its time).

const TICK_MS = Math.max(1_000, Number(process.env.REPORTS_TICK_MS) || 60_000);
/** Reports started per tick (more wait for the next tick). */
const PER_TICK = 5;

const g = globalThis as unknown as { __reports?: { started: boolean; ticking: boolean; owner: string; running: Set<string>; timer: ReturnType<typeof setInterval> | null; note?: string } };
const s = (g.__reports ??= { started: false, ticking: false, owner: `reports-${crypto.randomBytes(6).toString('hex')}`, running: new Set(), timer: null });
const log = (msg: string) => console.log(`[reports] ${msg}`);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const link = (runId: string) => {
  const base = (process.env.CONSOLE_PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/console/reports/runs/${runId}` : null;
};

/** Makes the report of `run` and, when asked, sends it to each of its channels once. */
export async function produce(d: ReportDefinition, run: ReportRunSummary, deliver: boolean): Promise<void> {
  s.running.add(run.id);
  try {
    let names: Map<string, string> | undefined;
    try { names = new Map((await knownAccounts()).map((a) => [a.id, a.name])); } catch { /* ids instead of names */ }
    let content;
    try {
      content = await buildReport(d, run, names);
    } catch (err) {
      await finishRun(run.id, { error: message(err) });
      log(`“${d.name}” could not be made: ${message(err)}`);
      return;
    }
    await finishRun(run.id, { content });
    if (!deliver) return;
    const subject = `${BRAND.name} report: ${d.name}`;
    for (const channel of d.channels) {
      // Claimed first: a run goes to a channel once, whatever happens next.
      if (!(await claimDelivery(run.id, channel))) continue;
      let r: { ok: boolean; error: string | null };
      try {
        r = await sendReport(channel, subject, slackMessage(content, BRAND.name, link(run.id)), webhookMessage(content, BRAND.name, link(run.id)));
      } catch (err) {
        r = { ok: false, error: message(err) };
      }
      await saveDelivery(run.id, channel, r.ok, r.error);
    }
  } finally {
    s.running.delete(run.id);
  }
}

/** "Generate now": a run made at once (and sent when `deliver`). Null while the same report is still being made. */
export async function runNow(d: ReportDefinition, by: string, deliver: boolean): Promise<ReportRunSummary | null> {
  const run = await startManual(d, by, s.owner);
  if (!run) return null;
  void produce(d, run, deliver).catch((err) => log(`“${d.name}”: ${message(err)}`));
  return run;
}

async function tick() {
  if (s.ticking) return;
  s.ticking = true;
  try {
    await failStale();
    for (const d of await dueDefinitions(PER_TICK)) {
      const run = await claimDue(d, s.owner);
      if (!run) continue; // another worker took it
      log(`making “${d.name}”`);
      void produce(d, run, true).catch((err) => log(`“${d.name}”: ${message(err)}`));
    }
    s.note = undefined;
  } catch (err) {
    // Usually the migration is missing: said once, not every minute.
    if (s.note !== message(err)) { s.note = message(err); log(`waiting: ${message(err)}`); }
  } finally {
    s.ticking = false;
  }
}

/** Starts looking for due reports (the worker only: like the monitoring schedule, never on the web side). */
export function startReportScheduler() {
  if (s.started || consoleRole() !== 'worker') return;
  s.started = true;
  s.timer = setInterval(() => { void tick(); }, TICK_MS);
  s.timer.unref?.();
  setTimeout(() => { void tick(); }, 2_000).unref?.();
}

/** Reports being made on this server. */
export const reportsBusy = () => s.running.size > 0;
