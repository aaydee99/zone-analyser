import 'server-only';
import { BudgetError, ReadError } from '../cf-read';
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

/** Cloudflare's words for a product the plan does not include (as opposed to a token without the permission). */
const NOT_ENTITLED = /not entitled|entitlement|subscri|upgrade|your plan|plan does not|not available (?:on|for) (?:this|your) plan/i;

/**
 * A read of something that is not there: 404, or a 401/403 saying the plan lacks the product.
 * Nothing to check, so the unit is still complete.
 */
export const notAvailable = (err: unknown) => err instanceof ReadError && (err.status === 404 || ((err.status === 401 || err.status === 403) && NOT_ENTITLED.test(err.message)));
/**
 * The token may not read this (401/403 for any other reason). Not a reason to give up on the unit,
 * but what was not read is not known: the unit is incomplete, so its old findings stay open.
 */
export const refusedRead = (err: unknown) => err instanceof ReadError && (err.status === 401 || err.status === 403) && !NOT_ENTITLED.test(err.message);

/** Collects read failures instead of stopping the unit. */
export class Problems {
  private errors: string[] = [];
  private refusedWhat: string[] = [];
  complete = true;
  /** What failed, for the check's page: each failure, and one line for the reads the token may not do. */
  get list(): string[] {
    return [...this.errors, ...(this.refusedWhat.length ? [`The token may not read ${this.refusedWhat.join(', ')} — give it the permission, or these are not checked`] : [])];
  }
  /** A read failed: the unit is incomplete. Waiting for the budget, or being stopped, ends the unit instead. */
  add(what: string, err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (err instanceof BudgetError) throw err;
    this.complete = false;
    this.errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
  /** Like add(), but something that is not there (notAvailable) is fine, and a refused read is listed once with the others. */
  skip(what: string, err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (err instanceof BudgetError) throw err;
    if (notAvailable(err)) return;
    if (refusedRead(err)) { this.complete = false; if (!this.refusedWhat.includes(what)) this.refusedWhat.push(what); return; }
    this.add(what, err);
  }
}

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
