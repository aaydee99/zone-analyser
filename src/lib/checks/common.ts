import 'server-only';
import { ReadError } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { CheckId, Column, ReportStat, Row, Severity } from '../monitor-types';

// What every check is made of: units of work, each reading one zone, one account, or (global) the
// whole console, run by the queue (src/lib/monitor-queue.ts) when they are due. A unit returns its
// table rows, findings and counts; the check's page sums the counts and pages through the rows.

export type ScopeKind = 'zone' | 'account' | 'global';

export interface UnitTarget {
  kind: ScopeKind;
  /** The zone or account ID; '*' for a global unit. */
  id: string;
  accountId: string;
  accountName: string;
  zoneName: string;
  /** The token the queue chose for this unit (none for a global unit: it gets `tokens`). */
  token: string;
  credentialName: string;
  /** Global units: every stored token, once each. */
  tokens: { token: string; credentialName: string }[];
}

export interface UnitContext {
  signal?: AbortSignal;
  /** What this unit kept from its last run (an audit-log cursor …). */
  state: unknown;
}

export interface UnitResult {
  /**
   * Table rows by section key; they replace the unit's rows from before. `_sort` (a number, lowest
   * first) orders a section; it is not shown. A unit that could read nothing throws instead, so its
   * last result stays on the page with the error beside it.
   */
  rows: Partial<Record<string, Row[]>>;
  findings: NewFinding[];
  /** Added up over every unit of the check for its stats. */
  counts?: Record<string, number>;
  /** Everything in scope was read: its old findings that were not found again are resolved. */
  complete: boolean;
  /** Reads that failed (shown on the check's page). */
  problems?: string[];
  /** Hours until the next run instead of the check's interval: shorter when something is urgent. */
  dueInHours?: number;
  /** Nothing here to watch (no product, no items): checked again only after the check's idle interval. */
  idle?: boolean;
  /** Kept for the next run. */
  state?: unknown;
  /** Other units of this check to run now (drift: the zones the audit log says changed). */
  wake?: { kind: ScopeKind; ids: string[] };
}

export type UnitRunner = (t: UnitTarget, ctx: UnitContext) => Promise<UnitResult>;

export interface SectionMeta {
  key: string;
  title: string;
  description?: string;
  columns: Column[];
  empty?: string;
}

export interface CheckDef {
  id: CheckId;
  units: Partial<Record<ScopeKind, UnitRunner>>;
  /** The kind whose interval is the check's (CheckMeta.every, or the one set in the settings). */
  main: ScopeKind;
  /** Fixed hours between runs for other kinds; a kind not listed runs at the check's interval. */
  every?: Partial<Record<ScopeKind, number>>;
  /** Kinds of unit that keep state between runs (UnitResult.state); the others never read it. */
  stateful?: ScopeKind[];
  /** Hours between runs of a unit with nothing to watch. */
  idleHours?: number;
  sections: SectionMeta[];
  /** The page's stats from the summed counts and the open findings. */
  stats: (t: Totals) => ReportStat[];
}

export interface Totals {
  counts: Record<string, number>;
  open: Record<Severity, number>;
  targets: { total: number; read: number; failing: number; never: number };
}

/** Collects read failures instead of stopping the unit. */
export class Problems {
  list: string[] = [];
  complete = true;
  add(what: string, err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    this.complete = false;
    this.list.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A read the plan or token does not allow (403/404) is "not available", not a failure worth listing per item. */
export const notAvailable = (err: unknown) => err instanceof ReadError && (err.status === 403 || err.status === 404 || err.status === 401);

export const DAY = 86_400_000;
export const daysUntil = (iso: string | null | undefined, now = Date.now()) => (iso && Number.isFinite(Date.parse(iso)) ? Math.floor((Date.parse(iso) - now) / DAY) : null);
export const daysSince = (iso: string | null | undefined, now = Date.now()) => (iso && Number.isFinite(Date.parse(iso)) ? Math.floor((now - Date.parse(iso)) / DAY) : null);

export const SEV_SORT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
export const TONE_SORT: Record<string, number> = { bad: 0, warn: 1, ok: 2, info: 3 };

export function severityStats(open: Record<Severity, number>): ReportStat[] {
  return [
    { label: 'Critical', value: open.critical, tone: open.critical ? 'bad' : 'ok' },
    { label: 'High', value: open.high, tone: open.high ? 'bad' : 'ok' },
    { label: 'Medium', value: open.medium, tone: open.medium ? 'warn' : 'ok' },
  ];
}

/** "6,410 of 6,532 read" for a check's coverage stat. */
export const readStat = (t: Totals, what = 'Read'): ReportStat => ({
  label: what, value: `${t.targets.read.toLocaleString('en-US')} of ${t.targets.total.toLocaleString('en-US')}`,
  tone: t.targets.failing ? 'warn' : t.targets.total && t.targets.read === t.targets.total ? 'ok' : undefined,
});
