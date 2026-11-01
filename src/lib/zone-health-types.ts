// Zone health: what the Health page and the Overview card get. Shared by server and client — no Node imports.

import type { Severity } from './monitor-types';
import { compactNum } from './num';

export type HealthSort = 'score' | 'best' | 'name' | 'findings';
export const HEALTH_SORTS: { value: HealthSort; label: string }[] = [
  { value: 'score', label: 'Worst first' }, { value: 'best', label: 'Best first' }, { value: 'findings', label: 'Most findings' }, { value: 'name', label: 'Name' },
];
export const isHealthSort = (v: unknown): v is HealthSort => HEALTH_SORTS.some((s) => s.value === v);

/** What took points off a zone's score (computed in 0018_zone_health.sql). */
export interface HealthBreakdown {
  findings?: { penalty: number; bySeverity: Partial<Record<Severity, number>>; byCheck: Record<string, number> };
  coverage?: { penalty: number; units: number; failing: number; never: number };
  certificates?: { penalty: number; minDays: number | null };
  drift?: { penalty: number; changes: number };
}

export interface HealthRow {
  zoneId: string; zoneName: string; accountId: string | null; accountName: string | null;
  score: number; openFindings: number; worst: Severity | null; breakdown: HealthBreakdown; computedAt: string;
}
export interface HealthPage { rows: HealthRow[]; total: number; offset: number }
export interface HealthSummary { zones: number; average: number | null; poor: number; fair: number; good: number; computedAt: string | null }
export interface HealthAccount { id: string; name: string; zones: number; average: number }

/** GET /api/zone-health */
export interface HealthView extends HealthPage { summary?: HealthSummary; accounts?: HealthAccount[]; generatedAt: string }

export const scoreTone = (s: number): 'bad' | 'warn' | 'ok' => (s < 50 ? 'bad' : s < 80 ? 'warn' : 'ok');

/** The score's explanation, one line per part that took points off. */
export function explain(b: HealthBreakdown, label: (check: string) => string = (c) => c): string[] {
  const out: string[] = [];
  const f = b.findings;
  if (f && f.penalty > 0) {
    const sev = (['critical', 'high', 'medium', 'low'] as Severity[]).filter((s) => f.bySeverity?.[s]).map((s) => `${f.bySeverity[s]} ${s}`).join(', ');
    const checks = Object.entries(f.byCheck ?? {}).sort((a, b2) => b2[1] - a[1]).map(([c, p]) => `${label(c)} −${p}`).join(', ');
    out.push(`Open findings (${sev}): −${f.penalty}${checks ? ` — ${checks}` : ''}`);
  }
  const c = b.coverage;
  if (c && c.penalty > 0) out.push(`Coverage: ${[c.failing ? `${compactNum(c.failing)} check${c.failing === 1 ? '' : 's'} failing` : '', c.never ? `${c.never} never read` : ''].filter(Boolean).join(', ')} of ${compactNum(c.units)}: −${c.penalty}`);
  const cert = b.certificates;
  if (cert && cert.penalty > 0) out.push(`Certificate ${cert.minDays !== null && cert.minDays < 0 ? 'expired' : `expires in ${cert.minDays} days`}: −${cert.penalty}`);
  const d = b.drift;
  if (d && d.penalty > 0) out.push(`${compactNum(d.changes)} change${d.changes === 1 ? '' : 's'} since the drift baseline: −${d.penalty}`);
  return out;
}
