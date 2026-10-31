import 'server-only';
import { BudgetError, ReadError } from '../cf-read';
import { accountTargets, zoneTargets, type AccountTarget, type ZoneTarget } from '../cf-targets';
import type { Progress } from '../bg-job';
import type { NewFinding } from '../monitor-store';
import type { CheckId, MonitorReport, ReportProblem, ReportSection, ReportStat, Severity } from '../monitor-types';

// What every check gets and gives back.

export interface CheckContext {
  progress: Progress;
  signal?: AbortSignal;
  accounts: () => Promise<{ accounts: AccountTarget[]; problems: ReportProblem[] }>;
  zones: () => Promise<{ zones: ZoneTarget[]; problems: ReportProblem[] }>;
}

export interface CheckResult {
  report: MonitorReport;
  findings: NewFinding[];
  /** Account and zone IDs read in full ('*' = everything the check covers): their old findings may be resolved. */
  read: Set<string>;
}

export type CheckRunner = (ctx: CheckContext) => Promise<CheckResult>;

/** Accounts and zones are listed once per run of several checks. */
export function makeContext(progress: Progress): CheckContext {
  let a: ReturnType<CheckContext['accounts']> | null = null;
  let z: ReturnType<CheckContext['zones']> | null = null;
  return {
    progress, signal: progress.signal,
    accounts: () => (a ??= accountTargets()),
    zones: () => (z ??= zoneTargets()),
  };
}

/** Builds the report; `partial` when a read stopped early. */
export function report(check: CheckId, started: number, stats: ReportStat[], sections: ReportSection[], problems: ReportProblem[], partial = false): MonitorReport {
  return { check, generatedAt: new Date().toISOString(), durationMs: Date.now() - started, stats, sections, problems, ...(partial ? { partial: true } : {}) };
}

/** Collects read failures instead of stopping the check; a rate-limit stop marks the report partial. */
export class Problems {
  list: ReportProblem[] = [];
  partial = false;
  add(scope: string, err: unknown) {
    if (err instanceof BudgetError) this.partial = true;
    if (err instanceof Error && err.name === 'AbortError') throw err;
    this.list.push({ scope, error: err instanceof Error ? err.message : String(err) });
  }
  /** Runs one read; a failure is noted and `fallback` returned. */
  async try<T>(scope: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try { return await fn(); } catch (err) { this.add(scope, err); return fallback; }
  }
}

/** A read the plan or token does not allow (403/404) is "not available", not a failure worth listing per item. */
export const notAvailable = (err: unknown) => err instanceof ReadError && (err.status === 403 || err.status === 404 || err.status === 401);

export const DAY = 86_400_000;
export const daysUntil = (iso: string | null | undefined, now = Date.now()) => (iso && Number.isFinite(Date.parse(iso)) ? Math.floor((Date.parse(iso) - now) / DAY) : null);
export const daysSince = (iso: string | null | undefined, now = Date.now()) => (iso && Number.isFinite(Date.parse(iso)) ? Math.floor((now - Date.parse(iso)) / DAY) : null);

export const countBy = (findings: NewFinding[], s: Severity) => findings.filter((f) => f.severity === s).length;

export function severityStats(findings: NewFinding[]): ReportStat[] {
  const crit = countBy(findings, 'critical'), high = countBy(findings, 'high'), med = countBy(findings, 'medium');
  return [
    { label: 'Critical', value: crit, tone: crit ? 'bad' : 'ok' },
    { label: 'High', value: high, tone: high ? 'bad' : 'ok' },
    { label: 'Medium', value: med, tone: med ? 'warn' : 'ok' },
  ];
}
