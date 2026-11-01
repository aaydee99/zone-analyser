// Builds an audit report from a snapshot: the configuration rules (rules.ts) and the traffic rules
// (effectiveness.ts) through one engine, so both keep the same coverage ledger. Pure.

import { effectivenessOf, TRAFFIC_RULES } from './effectiveness';
import { RULES, runRules, summarize, type RuleDef } from './rules';
import { SOURCES, type AuditReport, type AuditZone, type Snapshot, type SourceKey, type ZoneInfo } from './types';

export const ALL_RULES: RuleDef[] = [...RULES, ...TRAFFIC_RULES];

export function buildReport(s: Snapshot, meta: { accountId: string; accountName: string; startedAt: string; finishedAt: string; calls: number; lookups: number }): AuditReport {
  const { findings, coverage } = runRules(s, ALL_RULES);
  const z = s.reads.zone?.state === 'ok' ? s.reads.zone.value as ZoneInfo : null;
  const zone: AuditZone = { id: s.zoneId, name: z?.name || s.zoneName, accountId: meta.accountId, accountName: meta.accountName, plan: z?.plan ?? '', type: z?.type ?? '', status: z?.status ?? '' };
  const reads = (Object.keys(SOURCES) as SourceKey[]).map((key) => {
    const g = s.reads[key];
    return { key, label: SOURCES[key].label, state: g?.state ?? 'error' as const, ...(g && g.state !== 'ok' ? { reason: g.reason } : !g ? { reason: 'not read' } : {}) };
  });
  return {
    version: 1, zone, startedAt: meta.startedAt, finishedAt: meta.finishedAt, findings, coverage,
    summary: summarize(findings, coverage, meta.calls, meta.lookups), reads, effectiveness: effectivenessOf(s)?.eff ?? null,
  };
}
