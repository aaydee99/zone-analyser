'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, FileJson, RefreshCw } from 'lucide-react';
import { fmtDate } from '@/lib/client';
import { actionItems } from '@/lib/zone-audit/actions';
import { windowLabel, type AuditView } from '@/lib/zone-audit/types';
import { Alert, Button, ButtonLink, Loading, PageHeader, SkeletonTable, cx } from '@/components/ui';
import { useSnapshot } from '../../monitoring/use-run';
import {
  AuditNav, AuditState, Coverage, EffectivenessTable, Findings, ManagedOverviewCard, Method, RecommendedActions, Summary, effectId, findingId, type AuditTab,
} from '../audit-view';

interface View { audit: AuditView & { hours: number; error: string | null }; generatedAt: string }

/** Asked again every 3 seconds only while the audit runs; once it is finished, only Refresh reads it. */
const POLL_MS = 3_000;

/** The report's sections, in order; the fifth holds the coverage ledger and what was read. */
const TABS: { id: AuditTab; label: string }[] = [
  { id: 'findings', label: 'Findings' }, { id: 'actions', label: 'Recommended Actions' }, { id: 'effectiveness', label: 'Effectiveness' },
  { id: 'managed', label: 'Managed Ruleset' }, { id: 'coverage', label: 'Coverage' },
];
const isTab = (v: string | null): v is AuditTab => TABS.some((t) => t.id === v);
/** Managed-ruleset findings: the managed group, and the traffic rules about managed rulesets and their exceptions. */
const MANAGED_TRAFFIC = new Set(['traffic.managed_effect', 'traffic.owasp_effect', 'traffic.exception_passthrough']);

export default function AuditPage({ params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = use(params);
  const { data, error, loading, reload } = useSnapshot<View>(`/api/security-audit/${encodeURIComponent(auditId)}`);
  const a = data?.audit;
  const r = a?.report;
  const runningNow = a?.status === 'running';
  useEffect(() => {
    if (!runningNow) return;
    const t = setTimeout(() => { void reload(); }, POLL_MS);
    return () => clearTimeout(t);
  }, [runningNow, reload, data]);

  // The tab lives in the URL (?tab=…), so a section can be linked; Findings by default.
  const [tab, setTabState] = useState<AuditTab>('findings');
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (isTab(t)) queueMicrotask(() => setTabState(t));
  }, []);
  const setTab = useCallback((t: AuditTab, hash?: string) => {
    setTabState(t);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', t);
    u.hash = hash ?? '';
    window.history.replaceState(null, '', u);
    if (hash) setTimeout(() => window.dispatchEvent(new HashChangeEvent('hashchange')), 0);
  }, []);
  const nav = useMemo(() => ({ finding: (fp: string) => setTab('findings', findingId(fp)), effect: (key: string) => setTab('effectiveness', effectId(key)) }), [setTab]);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  const dl = (q: string) => `/api/security-audit/${encodeURIComponent(auditId)}/download?${q}`;
  const items = useMemo(() => (r ? actionItems(r) : []), [r]);
  const configFindings = useMemo(() => r?.findings.filter((f) => f.group !== 'traffic') ?? [], [r]);
  // Every finding is in Findings (the summary count); the managed and OWASP ones are also in Managed Ruleset.
  const trafficFindings = useMemo(() => r?.findings.filter((f) => f.group === 'traffic') ?? [], [r]);
  const managedFindings = useMemo(() => r?.findings.filter((f) => f.group === 'managed' || MANAGED_TRAFFIC.has(f.ruleId)) ?? [], [r]);
  const eventsNote = r?.reads.find((x) => x.key === 'events')?.reason;
  return (
    <div className="space-y-6">
      <Link href="/console/security-audit" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-3.5" />Security audit</Link>
      <PageHeader eyebrow="Security audit" title={a?.zoneName || a?.zoneId || 'Audit'}
        description={a ? <>Started {fmtDate(a.startedAt)}{a.startedBy ? ` by ${a.startedBy}` : ''} · traffic window {windowLabel(r?.effectiveness?.hours || a.hours)}{r?.zone.plan ? ` · ${r.zone.plan} plan` : ''}{r ? ` · ${r.summary.coverage.passed + r.summary.coverage.finding} of ${r.summary.rules} checks read` : ''}</> : undefined}
        actions={<>
          <Button variant="ghost" loading={loading && !!data} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {r && <>
            <ButtonLink href={dl('format=md')} download icon={<Download className="size-4" />}>REPORT.md</ButtonLink>
            <ButtonLink href={dl('format=json')} download icon={<FileJson className="size-4" />}>findings.json</ButtonLink>
            <ButtonLink href={dl('format=csv&part=findings')} download icon={<Download className="size-4" />}>CSV</ButtonLink>
          </>}
        </>} />
      {error && <Alert tone="bad" title="The audit could not be read">{error}</Alert>}
      {!data && !error && <Loading label="Loading the audit"><SkeletonTable rows={6} cols={4} /></Loading>}
      {a && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
          <AuditState status={a.status} />
          {a.finishedAt && <span>Finished {fmtDate(a.finishedAt)}</span>}
          {data && <span>As of {fmtDate(data.generatedAt)}</span>}
        </div>
      )}
      {a && runningNow && <Alert tone="info" title="Reading the zone">The audit runs on the worker; this page looks again every few seconds until it is done.</Alert>}
      {a && a.status === 'failed' && <Alert tone="bad" title="The audit did not finish">{a.error ?? 'Unknown error'}</Alert>}
      {r && (
        <AuditNav.Provider value={nav}>
          <p className="text-[13px] text-muted">Read-only: nothing was changed in Cloudflare. <strong className="font-medium text-ink-2">Confirmed</strong> means the zone&apos;s configuration (or the traffic numbers) proves the outcome; <strong className="font-medium text-ink-2">Needs validation</strong> means it depends on something they cannot show, and the finding says how to check.</p>
          <Summary r={r} />
          <div role="tablist" aria-label="Report sections" className="flex flex-wrap gap-1 border-b border-line">
            {TABS.map((t, i) => (
              <button key={t.id} ref={(el) => { tabRefs.current[i] = el; }} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
                onClick={() => setTab(t.id)} onKeyDown={(e) => onKey(e, i)}
                className={cx('-mb-px border-b-2 px-3 py-2 text-[13px] font-medium', tab === t.id ? 'border-signal text-ink' : 'border-transparent text-muted hover:text-ink')}>
                {t.label}
                {t.id === 'findings' && <span className="ml-1.5 tabular-nums text-xs text-faint">{configFindings.length + trafficFindings.length}</span>}
                {t.id === 'actions' && <span className="ml-1.5 tabular-nums text-xs text-faint">{items.length}</span>}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="space-y-6 rounded-[var(--radius-card)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            {tab === 'findings' && <>
              <Findings findings={configFindings} title="Configuration findings" description="Every configuration finding, worst first — managed rules and their exceptions included. Open one for its evidence, the fix and how to validate it." />
              <Findings findings={trafficFindings} title="Findings from traffic" description="What the security events of the window show. Each finding's rule is broken down in Effectiveness." />
            </>}
            {tab === 'actions' && <RecommendedActions items={items} e={r.effectiveness} />}
            {tab === 'effectiveness' && <>
              <EffectivenessTable e={r.effectiveness} note={eventsNote} />
              <div className="flex flex-wrap gap-2">
                <ButtonLink size="sm" variant="ghost" href={dl('format=csv&part=effectiveness')} download icon={<Download className="size-3.5" />}>Rule effectiveness CSV</ButtonLink>
              </div>
            </>}
            {tab === 'managed' && <>
              {r.managed ? <ManagedOverviewCard m={r.managed} /> : <Alert tone="info">This audit was made before the managed ruleset overview existed: run it again.</Alert>}
              <Findings findings={managedFindings} title="Managed rule findings" description="Deployment, overrides, OWASP tuning, credential checks, exceptions, and what the managed rulesets did in the traffic. The same findings are in the Findings tab." />
              <EffectivenessTable e={r.effectiveness} note={eventsNote} only="managed" title="Managed rules in the traffic" />
              <div className="flex flex-wrap gap-2"><ButtonLink size="sm" variant="ghost" href={dl('format=csv&part=managed')} download icon={<Download className="size-3.5" />}>Managed rulesets CSV</ButtonLink></div>
            </>}
            {tab === 'coverage' && <>
              <Coverage r={r} />
              <div className="flex flex-wrap gap-2"><ButtonLink size="sm" variant="ghost" href={dl('format=csv&part=coverage')} download icon={<Download className="size-3.5" />}>Coverage CSV</ButtonLink></div>
              <Method r={r} />
            </>}
          </div>
        </AuditNav.Provider>
      )}
    </div>
  );
}
