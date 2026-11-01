import 'server-only';
import { compactNum } from '@/lib/num';
import { db } from './supabase';
import { HttpError } from './http';
import { cachedActivity } from './cf-audit-cache';
import { actorLabel, byCategory, changeTitle, zoneLabel, type CfAuditReport, type CfChange } from './cf-audit-report';
import { CHECK, CHECKS, SEVERITIES, type CheckId, type Severity } from './monitor-types';
import { mustR } from './report-store';
import { accountTraffic, zoneTraffic } from './report-traffic';
import {
  CERT_DAYS, SPAN_MS, emptyCounts,
  type CertificatesSection, type ChangesSection, type CoverageSection, type FindingLine, type FindingsSection,
  type ReportContent, type ReportDefinition, type ReportRunSummary, type SectionKey, type TrafficSection,
} from './report-types';

// Makes one report from stored data: monitoring findings, certificate rows and coverage
// (monitor_findings, monitor_rows, monitor_targets, read with the RPCs of 0020_reports.sql), the
// Cloudflare activity report (cf-audit-cache.ts: the same cached read as the Cloudflare activity
// page, one audit-log read per account) and account-level traffic totals (report-traffic.ts). Runs
// on the worker. Only checks every role may see are included (Tokens & members is left out).

/** Which zones and accounts a report covers: null lists mean "no filter". */
export interface ResolvedScope { label: string; accounts: string[] | null; zones: string[] | null }

/** Zones with every tag (src/lib/zone-meta.ts, when the console has it). */
async function zonesTagged(tags: string[]): Promise<string[]> {
  let mod: { zoneIdsMatching?: (f: { tags: string[] }) => Promise<Set<string> | string[] | null> } | null = null;
  try { mod = await import('@/lib/zone-meta'); } catch { mod = null; }
  if (mod?.zoneIdsMatching) {
    const ids = await mod.zoneIdsMatching({ tags });
    return ids ? [...ids] : [];
  }
  // Without the module, the table itself (0015_zone_meta.sql).
  const res = await db().rpc('zone_meta_match', { p_tags: tags, p_owner: '', p_q: '' });
  if (res.error) throw new HttpError(503, 'Zone tags are not set up: run supabase/migrations/0015_zone_meta.sql');
  return ((res.data as { zone_ids: string[] | null }[] | null)?.[0]?.zone_ids) ?? [];
}

export async function resolveScope(d: Pick<ReportDefinition, 'scope' | 'accounts' | 'tags'>, accountNames?: Map<string, string>): Promise<ResolvedScope> {
  if (d.scope === 'accounts') {
    const names = d.accounts.map((a) => accountNames?.get(a) || a);
    return { label: d.accounts.length === 1 ? `Account ${names[0]}` : `${d.accounts.length} accounts: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}`, accounts: d.accounts, zones: null };
  }
  if (d.scope === 'tag') {
    const zones = await zonesTagged(d.tags);
    return { label: `Zones tagged ${d.tags.join(' + ')} (${compactNum(zones.length)})`, accounts: null, zones };
  }
  return { label: 'All zones and accounts', accounts: null, zones: null };
}

/** Checks whose findings everyone with runs:read may see. */
const OPEN_CHECKS: CheckId[] = CHECKS.filter((c) => c.perm === 'runs:read').map((c) => c.id);
const WHERE = (a: string | null, z: string | null) => [a, z].filter(Boolean).join(' › ');

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── Sections ────────────────────────────────────────────────────────────────

export async function findingsSection(s: ResolvedScope, since: string, until: string): Promise<FindingsSection> {
  const args = { p_checks: OPEN_CHECKS, p_accounts: s.accounts, p_zones: s.zones, p_since: since, p_until: until };
  const [counts, fresh, resolved] = await Promise.all([
    db().rpc('report_finding_counts', args),
    db().rpc('report_findings_list', { ...args, p_kind: 'new', p_limit: 25 }),
    db().rpc('report_findings_list', { ...args, p_kind: 'resolved', p_limit: 25 }),
  ]);
  const open = emptyCounts(), nw = emptyCounts(), gone = emptyCounts();
  for (const r of (mustR(counts, 'Counting findings') as { severity: Severity; open: number; fresh: number; resolved: number }[] | null) ?? []) {
    if (!SEVERITIES.includes(r.severity)) continue;
    open[r.severity] = Number(r.open); nw[r.severity] = Number(r.fresh); gone[r.severity] = Number(r.resolved);
  }
  type L = { check_id: CheckId; severity: Severity; title: string; account_name: string | null; zone_name: string | null; first_seen: string; resolved_at: string | null };
  const line = (r: L, at: string): FindingLine => ({ severity: r.severity, check: CHECK[r.check_id]?.label ?? r.check_id, title: r.title, where: WHERE(r.account_name, r.zone_name), at });
  const freshTop = ((mustR(fresh, 'Reading findings') as L[] | null) ?? []).map((r) => line(r, r.first_seen));
  const resolvedTop = ((mustR(resolved, 'Reading findings') as L[] | null) ?? []).map((r) => line(r, r.resolved_at ?? ''));
  const any = Object.values(open).some(Boolean) || Object.values(nw).some(Boolean) || Object.values(gone).some(Boolean);
  return { status: any ? 'ok' : 'nothing', open, fresh: nw, resolved: gone, freshTop, resolvedTop };
}

export async function certificatesSection(s: ResolvedScope): Promise<CertificatesSection> {
  const rows = mustR(await db().rpc('report_expiring_certs', { p_accounts: s.accounts, p_zones: s.zones, p_days: CERT_DAYS, p_limit: 100 }), 'Reading certificates') as { data: Record<string, unknown>; total: number }[] | null;
  const list = (rows ?? []).map((r) => {
    const d = r.data;
    const days = d.days === null || d.days === undefined ? null : Number(d.days);
    return { kind: String(d.kind ?? ''), name: String(d.name ?? ''), where: String(d.where ?? ''), status: String(d.status ?? ''), expires: typeof d.expires === 'string' ? d.expires : null, days };
  });
  const total = Number(rows?.[0]?.total ?? 0);
  return { status: total ? 'ok' : 'nothing', total, rows: list };
}

export async function coverageSection(s: ResolvedScope): Promise<CoverageSection> {
  const args = { p_checks: OPEN_CHECKS, p_accounts: s.accounts, p_zones: s.zones };
  const [cov, probs] = await Promise.all([db().rpc('report_coverage', args), db().rpc('report_coverage_problems', { ...args, p_limit: 25 })]);
  const checks = ((mustR(cov, 'Reading coverage') as { check_id: CheckId; targets: number; read_ok: number; failing: number; never: number }[] | null) ?? [])
    .map((r) => ({ check: r.check_id, label: CHECK[r.check_id]?.label ?? r.check_id, targets: Number(r.targets), read: Number(r.read_ok), failing: Number(r.failing), never: Number(r.never) }))
    .sort((a, b) => OPEN_CHECKS.indexOf(a.check as CheckId) - OPEN_CHECKS.indexOf(b.check as CheckId));
  type P = { check_id: CheckId; scope_kind: string; scope_id: string; account_name: string | null; zone_name: string | null; last_error: string; last_run_at: string | null };
  const problems = ((mustR(probs, 'Reading coverage') as P[] | null) ?? []).map((p) => ({
    check: CHECK[p.check_id]?.label ?? p.check_id,
    scope: p.scope_kind === 'zone' ? p.zone_name || p.scope_id : p.scope_kind === 'account' ? p.account_name || `Account ${p.scope_id}` : 'All tokens',
    error: p.last_error.slice(0, 300), at: p.last_run_at,
  }));
  if (!checks.length) return { status: 'unavailable', note: 'Monitoring has not listed any accounts or zones yet', checks, problems };
  return { status: checks.some((c) => c.failing || c.never) ? 'ok' : 'nothing', checks, problems };
}

/** Accounts read one by one up to this many; more are read together (one report over every account) and filtered. */
const PER_ACCOUNT_MAX = 10;

export async function changesSection(s: ResolvedScope, cadence: ReportDefinition['cadence'], periodStart: string): Promise<ChangesSection> {
  const range = cadence === 'daily' ? 'day' : 'week';
  const reports: CfAuditReport[] = [];
  const problems: ChangesSection['problems'] = [];
  try {
    if (s.accounts && s.accounts.length <= PER_ACCOUNT_MAX) {
      for (const a of s.accounts) {
        try { reports.push(await cachedActivity(new URL(`http://report.local/?range=${range}&accountId=${a}`))); }
        catch (err) { problems.push({ account: a, error: errText(err) }); }
      }
    } else reports.push(await cachedActivity(new URL(`http://report.local/?range=${range}`)));
  } catch (err) {
    return { status: 'unavailable', note: errText(err), total: 0, byCategory: [], top: [], zoneEvents: { added: 0, activated: 0, removed: 0 }, problems, readAt: null };
  }
  const zoneSet = s.zones ? new Set(s.zones) : null;
  const acctSet = s.accounts ? new Set(s.accounts) : null;
  const inScope = (x: { accountId: string; zoneId: string }) => (!acctSet || acctSet.has(x.accountId)) && (!zoneSet || (!!x.zoneId && zoneSet.has(x.zoneId)));
  const changes: CfChange[] = reports.flatMap((r) => r.changes).filter((c) => inScope(c) && c.time >= periodStart);
  changes.sort((a, b) => (a.time < b.time ? 1 : -1));
  const events = reports.flatMap((r) => r.zoneEvents).filter((e) => inScope(e) && e.time >= periodStart);
  for (const r of reports) for (const a of r.accounts) {
    if (acctSet && a.accountId && !acctSet.has(a.accountId)) continue;
    if (a.error) problems.push({ account: a.accountName || a.accountId || a.credentialName, error: a.error });
    else if (a.truncated) problems.push({ account: a.accountName || a.accountId, error: 'More changes than one report reads: the oldest are left out' });
  }
  const groups = byCategory(changes).map((g) => ({ label: g.label, total: g.tally.total, create: g.tally.create, update: g.tally.update, delete: g.tally.delete }));
  const readAt = reports.map((r) => r.readAt).filter((x): x is string => !!x).sort()[0] ?? null;
  const zoneEvents = { added: events.filter((e) => e.event === 'added').length, activated: events.filter((e) => e.event === 'activated').length, removed: events.filter((e) => e.event === 'removed').length };
  const nothing = !changes.length && !events.length;
  return {
    status: nothing ? 'nothing' : 'ok', total: changes.length, byCategory: groups,
    top: changes.slice(0, 25).map((c) => ({ time: c.time, title: changeTitle(c), zone: zoneLabel(c), account: c.accountName || c.accountId, actor: actorLabel(c) })),
    zoneEvents, problems: problems.slice(0, 50), readAt,
  };
}

export async function trafficSection(s: ResolvedScope, end: Date, span: number): Promise<TrafficSection> {
  const cur = { since: new Date(end.getTime() - span).toISOString(), until: end.toISOString() };
  const prev = { since: new Date(end.getTime() - 2 * span).toISOString(), until: cur.since };
  return s.zones ? zoneTraffic(s.zones, cur, prev) : accountTraffic(s.accounts, cur, prev);
}

// ── The whole report ────────────────────────────────────────────────────────

/** Makes the report for `run`. A section that fails says why; the others are still made. */
export async function buildReport(d: ReportDefinition, run: Pick<ReportRunSummary, 'periodStart' | 'periodEnd' | 'since'>, accountNames?: Map<string, string>): Promise<ReportContent> {
  const scope = await resolveScope(d, accountNames);
  const end = new Date(run.periodEnd);
  const span = SPAN_MS[d.cadence];
  const want = new Set<SectionKey>(d.sections);
  const out: ReportContent = {
    version: 1, name: d.name, cadence: d.cadence, scope: { kind: d.scope, label: scope.label }, generatedAt: new Date().toISOString(),
    periodStart: run.periodStart, periodEnd: run.periodEnd, since: run.since, sections: {},
  };
  const safe = async <T,>(fn: () => Promise<T>, failed: (note: string) => T): Promise<T> => {
    try { return await fn(); } catch (err) { return failed(errText(err)); }
  };
  // A tag that matches nothing: every section is "nothing", nothing is read.
  const empty = !!scope.zones && !scope.zones.length;
  const none = 'No zone has these tags';
  await Promise.all([
    want.has('findings') && (async () => {
      out.sections.findings = empty
        ? { status: 'nothing', note: none, open: emptyCounts(), fresh: emptyCounts(), resolved: emptyCounts(), freshTop: [], resolvedTop: [] }
        : await safe(() => findingsSection(scope, run.since, run.periodEnd), (note) => ({ status: 'unavailable', note, open: emptyCounts(), fresh: emptyCounts(), resolved: emptyCounts(), freshTop: [], resolvedTop: [] }));
    })(),
    want.has('certificates') && (async () => {
      out.sections.certificates = empty ? { status: 'nothing', note: none, total: 0, rows: [] }
        : await safe(() => certificatesSection(scope), (note) => ({ status: 'unavailable', note, total: 0, rows: [] }));
    })(),
    want.has('coverage') && (async () => {
      out.sections.coverage = empty ? { status: 'nothing', note: none, checks: [], problems: [] }
        : await safe(() => coverageSection(scope), (note) => ({ status: 'unavailable', note, checks: [], problems: [] }));
    })(),
    want.has('changes') && (async () => {
      out.sections.changes = empty ? { status: 'nothing', note: none, total: 0, byCategory: [], top: [], zoneEvents: { added: 0, activated: 0, removed: 0 }, problems: [], readAt: null }
        : await safe(() => changesSection(scope, d.cadence, run.periodStart), (note) => ({ status: 'unavailable', note, total: 0, byCategory: [], top: [], zoneEvents: { added: 0, activated: 0, removed: 0 }, problems: [], readAt: null }));
    })(),
    want.has('traffic') && (async () => {
      out.sections.traffic = empty ? { status: 'nothing', note: none, read: 0, of: 0, unit: 'zones', current: null, previous: null, security: null, securityPrevious: null, problems: [] }
        : await safe(() => trafficSection(scope, end, span), (note) => ({ status: 'unavailable', note, read: 0, of: 0, unit: scope.zones ? 'zones' : 'accounts', current: null, previous: null, security: null, securityPrevious: null, problems: [] }));
    })(),
  ]);
  return out;
}
