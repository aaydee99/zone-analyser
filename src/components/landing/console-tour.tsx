'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, CloudUpload, Database, History, KeyRound, Pause, Play, Radar, RefreshCw, Search, ShieldAlert, Undo2 } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import { useInView, usePageVisible, useReducedMotion } from './motion';
import { BrandMark } from '@/components/brand-mark';

// A working mock of the console, drawn in HTML: a cursor walks through a security audit report, a
// monitoring refresh, a revert review in Cloudflare activity, a backup, a restore compare and a
// traffic drill-down, and the mock answers with its own toasts. Every zone, number and toast is
// sample data on example.com / example.net. Visitors can drive it themselves (it pauses the tour).

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Scene = 'audit' | 'monitoring' | 'activity' | 'backup' | 'restore' | 'traffic';
type Phase = 'idle' | 'running' | 'done';
type AuditTab = 'findings' | 'actions' | 'effectiveness' | 'managed';
interface Ping { id: number; title: string; detail: string }

const SCENES: { key: Scene; label: string; short: string; icon: typeof Database }[] = [
  { key: 'audit', label: 'Security audit', short: 'Audit', icon: ShieldAlert },
  { key: 'monitoring', label: 'Monitoring', short: 'Monitor', icon: Radar },
  { key: 'activity', label: 'Cloudflare activity', short: 'Activity', icon: History },
  { key: 'backup', label: 'Backups', short: 'Backup', icon: Database },
  { key: 'restore', label: 'Restore', short: 'Restore', icon: Undo2 },
  { key: 'traffic', label: 'Traffic', short: 'Traffic', icon: Activity },
];
const DECOR = [
  { label: 'Zone explorer', icon: Search },
  { label: 'Credentials', icon: KeyRound },
];
// The audit report's own tab labels (the console's fifth, Coverage, is left out of the mock).
const AUDIT_TABS: { key: AuditTab; label: string }[] = [
  { key: 'findings', label: 'Findings' },
  { key: 'actions', label: 'Recommended Actions' },
  { key: 'effectiveness', label: 'Effectiveness' },
  { key: 'managed', label: 'Managed Ruleset' },
];

// Sample month: 30 days of requests (relative heights), one spike on day 17.
const DAYS = Array.from({ length: 30 }, (_, i) => {
  if (i === 16) return 96;
  const weekend = i % 7 === 4 || i % 7 === 5;
  return Math.round(48 + 14 * Math.sin(i / 2.6) + (weekend ? -12 : 6) + ((i * 37) % 9));
});
const SPIKE = 16;
// The spike day per hour, with the attack at 14:00 UTC.
const HOURS = Array.from({ length: 24 }, (_, h) => (h === 14 ? 100 : h === 15 ? 62 : Math.round(22 + 16 * Math.sin((h - 6) / 3.8) + ((h * 13) % 7))));

/** `checks`: the audit's rule count (src/lib/zone-audit ALL_RULES), passed in so the rules stay off the client. */
export function ConsoleTour({ checks }: { checks: number }) {
  const root = useRef<HTMLDivElement>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const onScreen = useInView(rootEl, { threshold: 0.35 });

  const [scene, setScene] = useState<Scene>('audit');
  const [auditTab, setAuditTab] = useState<AuditTab>('findings');
  const [monitor, setMonitor] = useState<Phase>('done');
  const [revert, setRevert] = useState(false);
  const [backup, setBackup] = useState<Phase>('done');
  const [compare, setCompare] = useState<Phase>('done');
  const [drill, setDrill] = useState(false);
  const [pings, setPings] = useState<Ping[]>([]);
  const [paused, setPaused] = useState(false);
  const [step, setStep] = useState(0);
  const [cursor, setCursor] = useState({ x: 0, y: 0, down: false, shown: false });
  const pingId = useRef(0);

  const touring = !reduced && !paused;
  const running = touring && visible && onScreen;

  /** Back to the top of the tour: the audit's Findings, every demo button unpressed. */
  const reset = useCallback(() => {
    setScene('audit'); setAuditTab('findings'); setMonitor('idle'); setRevert(false);
    setBackup('idle'); setCompare('idle'); setDrill(false);
  }, []);

  useEffect(() => { setRootEl(root.current); }, []);
  // A visitor who wants motion starts from a clean slate; reduced motion keeps the finished state.
  useEffect(() => {
    if (reduced) return;
    reset(); setStep(0);
  }, [reduced, reset]);

  const ping = useCallback((title: string, detail: string) => {
    const id = ++pingId.current;
    setPings((p) => [...p.slice(-1), { id, title, detail }]);
    window.setTimeout(() => setPings((p) => p.filter((x) => x.id !== id)), 3600);
  }, []);

  const moveTo = useCallback((target: string) => {
    const box = root.current;
    const el = box?.querySelector<HTMLElement>(`[data-tour="${target}"]`);
    if (!box || !el) return;
    // A target inside a scrolling strip (phone tabs, audit tabs): bring it into the strip first.
    const strip = el.closest<HTMLElement>('[data-tour-strip]');
    if (strip) {
      const s = strip.getBoundingClientRect(), e = el.getBoundingClientRect();
      if (e.left < s.left || e.right > s.right) strip.scrollLeft += e.left - s.left - 8;
    }
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.width === 0) return; // hidden at this width (e.g. the sidebar on phones)
    setCursor({ x: r.left - b.left + Math.min(r.width * 0.62, r.width - 6), y: r.top - b.top + r.height * 0.6, down: false, shown: true });
  }, []);
  const press = useCallback(() => {
    setCursor((c) => ({ ...c, down: true }));
    window.setTimeout(() => setCursor((c) => ({ ...c, down: false })), 170);
  }, []);
  const nav = (s: Scene) => (window.matchMedia('(min-width: 768px)').matches ? `nav-${s}` : `tab-${s}`);

  // The tour, one step at a time: [wait before it, what it does].
  const steps: [number, () => void][] = [
    [900, () => moveTo('audit-tab-actions')],
    [850, () => { press(); setAuditTab('actions'); }],
    [2400, () => moveTo('audit-tab-effectiveness')],
    [800, () => { press(); setAuditTab('effectiveness'); ping('Rule effectiveness', 'example.com · “Login watch” let 18.4k bots through'); }],
    [3000, () => moveTo(nav('monitoring'))],
    [800, () => { press(); setScene('monitoring'); }],
    [650, () => moveTo('monitor-refresh')],
    [800, () => { press(); setMonitor('running'); }],
    [1300, () => { setMonitor('done'); ping('Monitoring refreshed', 'example.com · 1 new finding · drift'); }],
    [2200, () => moveTo(nav('activity'))],
    [800, () => { press(); setScene('activity'); setRevert(false); }],
    [650, () => moveTo('activity-revert')],
    [800, () => { press(); setRevert(true); ping('Revert ready to review', 'PATCH · Global API Key asked to send'); }],
    [2600, () => moveTo(nav('backup'))],
    [800, () => { press(); setScene('backup'); }],
    [700, () => moveTo('backup-start')],
    [850, () => { press(); setBackup('running'); }],
    [1700, () => { setBackup('done'); ping('Backup complete', 'example.com · 42 resources · .tf + JSON'); }],
    [1700, () => moveTo(nav('restore'))],
    [800, () => { press(); setScene('restore'); }],
    [650, () => moveTo('restore-compare')],
    [800, () => { press(); setCompare('running'); }],
    [1300, () => { setCompare('done'); ping('Restore plan ready', 'example.com · 2 to change · 0 to delete'); }],
    [2300, () => moveTo(nav('traffic'))],
    [800, () => { press(); setScene('traffic'); setDrill(false); }],
    [700, () => moveTo('traffic-spike')],
    [850, () => { press(); setDrill(true); ping('17 Oct, per hour', 'example.net · spike at 14:00 UTC'); }],
    [2800, () => moveTo(nav('audit'))],
    [800, () => { press(); reset(); }],
  ];

  useEffect(() => {
    if (!running) return;
    const [wait, run] = steps[step % steps.length];
    const t = window.setTimeout(() => { run(); setStep((s) => (s + 1) % steps.length); }, wait);
    return () => window.clearTimeout(t);
    // steps is rebuilt each render from stable callbacks; the step index drives the schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, step]);

  // Anything the visitor does by hand takes over from the tour.
  const takeOver = () => { if (!paused) setPaused(true); setCursor((c) => ({ ...c, shown: false })); };
  const go = (s: Scene) => { takeOver(); setScene(s); };
  const startBackup = () => {
    takeOver(); setBackup('running');
    window.setTimeout(() => { setBackup('done'); ping('Backup complete', 'example.com · 42 resources · .tf + JSON'); }, 1400);
  };
  const runCompare = () => {
    takeOver(); setCompare('running');
    window.setTimeout(() => { setCompare('done'); ping('Restore plan ready', 'example.com · 2 to change · 0 to delete'); }, 1100);
  };
  const refreshMonitor = () => {
    takeOver(); setMonitor('running');
    window.setTimeout(() => { setMonitor('done'); ping('Monitoring refreshed', 'example.com · 1 new finding · drift'); }, 1100);
  };

  const togglePause = () => {
    if (paused) {
      // Resume from the top of the tour so the cursor never jumps mid-story.
      reset(); setStep(0); setPaused(false);
    } else { setPaused(true); setCursor((c) => ({ ...c, shown: false })); }
  };

  return (
    <figure className="m-0">
      <div ref={root} className="lp-mock relative isolate overflow-hidden">
        {/* Window bar */}
        <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 sm:px-4">
          <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
            <Mark />
            <span className="font-semibold text-ink">{BRAND.name}</span>
            <span className="hidden text-faint sm:inline">/</span>
            <span className="hidden truncate text-muted sm:inline">{SCENES.find((s) => s.key === scene)?.label}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-line-strong bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">Demo · sample data</span>
            {/* Always laid out so the bar never changes height; hidden under reduced motion (no tour). */}
            <button type="button" onClick={togglePause} aria-pressed={paused} tabIndex={reduced ? -1 : undefined}
                className={`${reduced ? 'invisible' : ''} inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-2 text-[11.5px] text-ink-2 transition-colors hover:bg-raised hover:text-ink`}>
                {paused ? <Play aria-hidden="true" className="size-3" /> : <Pause aria-hidden="true" className="size-3" />}
                {paused ? 'Play tour' : 'Pause tour'}
            </button>
          </div>
        </div>

        {/* Phone: the scenes as tabs (a strip that scrolls sideways) */}
        <div data-tour-strip className="flex gap-1 overflow-x-auto border-b border-line px-2 py-1.5 md:hidden">
          {SCENES.map(({ key, short, icon: Icon }) => (
            <button key={key} type="button" data-tour={`tab-${key}`} onClick={() => go(key)} aria-pressed={scene === key}
              className={cx('inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors',
                scene === key ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}>
              <Icon aria-hidden="true" className="size-3.5" />{short}
            </button>
          ))}
        </div>

        <div className="grid md:grid-cols-[13.5rem_1fr]">
          {/* Sidebar */}
          <nav aria-label="Demo console sections" className="hidden border-r border-line p-3 md:block">
            <ul className="space-y-0.5">
              {SCENES.map(({ key, label, icon: Icon }) => (
                <li key={key}>
                  <button type="button" data-tour={`nav-${key}`} onClick={() => go(key)} aria-pressed={scene === key}
                    className={cx('flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors',
                      scene === key ? 'bg-raised text-ink' : 'text-ink-2 hover:bg-raised/60 hover:text-ink')}>
                    <Icon aria-hidden="true" className={cx('size-4', scene === key ? 'text-signal' : 'text-faint')} />{label}
                  </button>
                </li>
              ))}
              {DECOR.map(({ label, icon: Icon }) => (
                <li key={label} className="flex h-9 items-center gap-2.5 px-2.5 text-[13px] text-faint">
                  <Icon aria-hidden="true" className="size-4" />{label}
                </li>
              ))}
            </ul>
          </nav>

          <div className="lp-mock-main relative p-3 sm:p-5">
            {scene === 'audit' && <AuditScene tab={auditTab} checks={checks} onTab={(t) => { takeOver(); setAuditTab(t); }} />}
            {scene === 'monitoring' && <MonitoringScene phase={monitor} onRefresh={refreshMonitor} />}
            {scene === 'activity' && <ActivityScene review={revert} onRevert={() => { takeOver(); setRevert(true); }} onBack={() => { takeOver(); setRevert(false); }} />}
            {scene === 'backup' && <BackupScene phase={backup} onStart={startBackup} />}
            {scene === 'restore' && <RestoreScene phase={compare} onCompare={runCompare} />}
            {scene === 'traffic' && <TrafficScene drill={drill} onDrill={() => { takeOver(); setDrill(true); }} onBack={() => { takeOver(); setDrill(false); }} />}
          </div>
        </div>

        {/* Toasts of the demo console (decorative: the scene itself shows the same result). */}
        <div aria-hidden="true" className="pointer-events-none absolute right-3 bottom-3 z-20 flex w-[min(19rem,calc(100%-1.5rem))] flex-col gap-2">
          {pings.map((p) => (
            <div key={p.id} className="lp-ping flex items-start gap-2.5 rounded-xl border border-line-strong bg-surface px-3 py-2.5 shadow-[0_14px_30px_-12px_rgb(0_0_0/0.7)]">
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-ok/15 text-ok"><Check className="size-3" /></span>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-semibold text-ink">{p.title}</span>
                <span className="block truncate font-mono text-[11px] text-muted">{p.detail}</span>
              </span>
            </div>
          ))}
        </div>

        {/* The cursor */}
        {touring && (
          <svg aria-hidden="true" viewBox="0 0 24 24" className={cx('lp-cursor', cursor.shown && 'is-shown', cursor.down && 'is-down')}
            style={{ transform: `translate3d(${cursor.x}px, ${cursor.y}px, 0)` }}>
            <path d="M4 2.5 19.5 12l-7 1.6L9 20.5z" fill="var(--color-ink)" stroke="var(--color-terminal)" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <figcaption className="mt-3 text-center text-[12.5px] text-faint">
        An interactive mock of the console with sample data. Use the sections to look around.
      </figcaption>
    </figure>
  );
}

function Mark() {
  return (
    <BrandMark className="h-4 shrink-0" />
  );
}

function Title({ children, meta }: { children: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="text-[15px] font-semibold text-ink">{children}</p>
      {meta && <p className="font-mono text-[11px] text-faint">{meta}</p>}
    </div>
  );
}

const SEV_TONE = { high: 'bg-bad/12 text-bad', medium: 'bg-warn/12 text-warn', low: 'bg-info/12 text-info' } as const;
function Sev({ s }: { s: keyof typeof SEV_TONE }) {
  return <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium capitalize', SEV_TONE[s])}>{s}</span>;
}

function AuditScene({ tab, checks, onTab }: { tab: AuditTab; checks: number; onTab: (t: AuditTab) => void }) {
  return (
    <div className="lp-scene">
      <Title meta={`last 7 days · ${checks - 2} of ${checks} checks read`}>Security audit · example.com</Title>
      <div data-tour-strip className="-mx-1 mb-3 flex gap-1 overflow-x-auto px-1 pb-0.5">
        {AUDIT_TABS.map((t) => (
          <button key={t.key} type="button" data-tour={`audit-tab-${t.key}`} onClick={() => onTab(t.key)} aria-pressed={tab === t.key}
            className={cx('h-8 shrink-0 rounded-md border px-2.5 text-[12px] transition-colors',
              tab === t.key ? 'border-signal/60 bg-signal/10 text-ink' : 'border-line text-muted hover:text-ink')}>
            {t.label}
          </button>
        ))}
      </div>
      <div key={tab} className="lp-scene">
        {tab === 'findings' && <AuditFindings />}
        {tab === 'actions' && <AuditActions />}
        {tab === 'effectiveness' && <AuditEffect />}
        {tab === 'managed' && <AuditManaged />}
      </div>
    </div>
  );
}

function AuditFindings() {
  // Titles in the shape the audit writes them (effectiveness.ts, managed-effect.ts, rules.ts).
  const rows: { sev: keyof typeof SEV_TONE; verdict: string; area: string; title: string }[] = [
    { sev: 'high', verdict: 'Confirmed', area: 'Traffic', title: 'Custom rule “Login watch” let 18.4k automated requests through (62% of 29.7k)' },
    { sev: 'medium', verdict: 'Confirmed', area: 'Managed rules', title: 'OWASP flagged 2.1k requests in the last 7 days and blocked none' },
    { sev: 'medium', verdict: 'Needs validation', area: 'Origin exposure', title: 'Unproxied records that reveal a proxied origin' },
  ];
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.title} className="rounded-xl border border-line bg-sunken/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
            <Sev s={r.sev} />
            <span className={cx('rounded-md px-1.5 py-0.5 font-medium', r.verdict === 'Confirmed' ? 'bg-ok/12 text-ok' : 'bg-raised-2 text-ink-2')}>{r.verdict}</span>
            <span className="text-faint">{r.area}</span>
          </div>
          <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-ink">{r.title}</p>
        </li>
      ))}
    </ul>
  );
}

function AuditActions() {
  return (
    <ol className="space-y-2">
      <li className="rounded-xl border border-line bg-sunken/60 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10.5px]"><span className="font-mono text-faint">1</span><Sev s="high" /></div>
        <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-ink">Switch “Login watch” from Log to Managed Challenge: it let 18.4k automated requests (62%; bot score 1–29) through</p>
        <p className="mt-1 truncate text-[11px] text-muted">Security › WAF › Custom rules › “Login watch”: change the action from Log to Managed Challenge.</p>
      </li>
      <li className="rounded-xl border border-line bg-sunken/60 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10.5px]"><span className="font-mono text-faint">2</span><Sev s="medium" /></div>
        <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-snug text-ink">Narrow “Partner API skip”: its skip let 3.1k malicious requests (WAF attack score 1–20) through</p>
        <p className="mt-1.5 truncate rounded-md bg-terminal px-2 py-1 font-mono text-[11px] text-ink-2">(http.request.uri.path wildcard &quot;/api/partner/*&quot;) and not (cf.waf.score lt 21)</p>
      </li>
    </ol>
  );
}

function Split({ blocked, challenged, passed }: { blocked: number; challenged: number; passed: number }) {
  return (
    <span aria-hidden="true" className="flex h-1.5 overflow-hidden rounded-full bg-raised-2">
      <span className="bg-bad" style={{ width: `${blocked}%` }} />
      <span className="bg-warn" style={{ width: `${challenged}%` }} />
      <span className="bg-signal" style={{ width: `${passed}%` }} />
    </span>
  );
}

function AuditEffect() {
  return (
    <div className="space-y-2">
      <div className="rounded-xl border border-line bg-sunken/60 px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="min-w-0 truncate text-ink-2">Custom rule “Block bad ASNs” · Block</span>
          <span className="shrink-0 font-mono text-[11px] text-faint">41.2k events</span>
        </div>
        <div className="mt-2"><Split blocked={100} challenged={0} passed={0} /></div>
      </div>
      <div className="rounded-xl border border-signal/50 bg-sunken/60 px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="min-w-0 truncate text-ink">Custom rule “Login watch” · Log</span>
          <span className="shrink-0 font-mono text-[11px] text-faint">29.7k events</span>
        </div>
        <div className="mt-2"><Split blocked={0} challenged={0} passed={100} /></div>
        <dl className="mt-2 grid grid-cols-4 gap-1.5 text-[10.5px]">
          {[['Blocked', '0'], ['Challenged', '0'], ['Passed', '29.7k'], ['Bots passed', '18.4k']].map(([k, v]) => (
            <div key={k}><dt className="text-faint">{k}</dt><dd className="font-mono text-[12px] text-ink tabular-nums">{v}</dd></div>
          ))}
        </dl>
        <p className="mt-2 truncate font-mono text-[11px] text-muted">/wp-login.php · /login · US · DE · AS14061 (hosting)</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <span className="text-faint">Recommended</span>
          <span className="lp-del rounded px-1 font-mono">Log</span><ArrowRight aria-hidden="true" className="size-3 text-faint" /><span className="lp-add rounded px-1 font-mono">Managed Challenge</span>
        </p>
      </div>
    </div>
  );
}

function AuditManaged() {
  const rows = [
    { name: 'Cloudflare Managed Ruleset', state: 'deployed', note: '3 rules matched only in log (412 events)' },
    { name: 'OWASP Core Ruleset', state: 'PL1 · threshold 40', note: 'Flagged 2.1k requests and blocked none' },
    { name: 'Exception “Allow uploads”', state: 'skip', note: 'Skips 12 managed rules · let 640 requests through' },
  ];
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.name} className="rounded-xl border border-line bg-sunken/60 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[12.5px] text-ink">{r.name}</span>
            <span className="shrink-0 rounded-md bg-raised-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2">{r.state}</span>
          </div>
          <p className="mt-1 truncate text-[11.5px] text-muted">{r.note}</p>
        </li>
      ))}
    </ul>
  );
}

function MonitoringScene({ phase, onRefresh }: { phase: Phase; onRefresh: () => void }) {
  const zones = [
    { name: 'shop.example.com', score: 64 },
    { name: 'example.net', score: 78 },
    { name: 'example.com', score: 92 },
  ];
  const tone = (s: number) => (s < 50 ? 'text-bad' : s < 80 ? 'text-warn' : 'text-ok');
  const findings: { sev: keyof typeof SEV_TONE; check: string; text: string }[] = [
    ...(phase === 'done' ? [{ sev: 'medium' as const, check: 'Drift', text: 'example.com · security_level changed since the accepted baseline' }] : []),
    { sev: 'high', check: 'Certificates', text: 'shop.example.com · edge certificate expires in 5 days' },
    { sev: 'medium', check: 'Logpush', text: 'example.net · job “http-requests” failing' },
  ];
  return (
    <div className="lp-scene">
      <Title meta="results from 09:40 UTC">Monitoring</Title>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="rounded-xl border border-line bg-sunken/60 p-3">
          <p className="text-[11px] font-medium text-faint">Zone health · worst first</p>
          <ul className="mt-2 space-y-1.5">
            {zones.map((z) => (
              <li key={z.name} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-[12px] text-ink-2">{z.name}</span>
                <span className={cx('font-mono text-[13px] tabular-nums', tone(z.score))}>{z.score}</span>
              </li>
            ))}
          </ul>
        </div>
        <ul className="space-y-1.5">
          {findings.map((f) => (
            <li key={f.text} className="rounded-xl border border-line bg-sunken/60 px-3 py-1.5">
              <div className="flex items-center gap-1.5 text-[10.5px]"><Sev s={f.sev} /><span className="text-faint">{f.check}</span></div>
              <p className="mt-1 truncate text-[12px] text-ink">{f.text}</p>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" data-tour="monitor-refresh" onClick={onRefresh} disabled={phase === 'running'}
          className="relative inline-flex h-9 items-center gap-2 overflow-hidden rounded-[10px] border border-line-strong bg-raised px-4 text-[13px] font-medium text-ink hover:bg-raised-2">
          {phase === 'running' && <span aria-hidden="true" className="progress-live absolute inset-0 opacity-40" />}
          <span className="relative inline-flex items-center gap-2"><RefreshCw aria-hidden="true" className="size-3.5" />{phase === 'running' ? 'Refreshing…' : 'Refresh'}</span>
        </button>
        <span className="font-mono text-[11px] text-faint">Slack + webhook · new findings at medium and above</span>
      </div>
    </div>
  );
}

function ActivityScene({ review, onRevert, onBack }: { review: boolean; onRevert: () => void; onBack: () => void }) {
  const changes = [
    { cat: 'Security rules', zone: 'example.com', at: '09:41 UTC', field: 'rules[Login watch].action', from: 'block', to: 'log', who: 'ops@example.com' },
    { cat: 'SSL/TLS', zone: 'example.net', at: '08:12 UTC', field: 'min_tls_version', from: '1.2', to: '1.0', who: 'dev@example.net' },
  ];
  return (
    <div className="lp-scene">
      <Title meta="last 7 days · every account">Cloudflare activity</Title>
      {!review ? (
        <ul className="space-y-2">
          {changes.map((c, i) => (
            <li key={c.field} className="rounded-xl border border-line bg-sunken/60 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="truncate text-ink-2">{c.cat} · {c.zone}</span>
                <span className="shrink-0 font-mono text-faint">{c.at}</span>
              </div>
              <p className="mt-1.5 truncate font-mono text-[12px] text-ink">{c.field}</p>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[12px]">
                <span className="lp-del rounded px-1">{c.from}</span><ArrowRight aria-hidden="true" className="size-3 text-faint" /><span className="lp-add rounded px-1">{c.to}</span>
              </p>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="truncate text-[12px] text-muted">{c.who}</span>
                <button type="button" data-tour={i === 0 ? 'activity-revert' : undefined} onClick={onRevert}
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-line-strong px-2 text-[12px] text-ink-2 hover:bg-raised hover:text-ink">
                  <Undo2 aria-hidden="true" className="size-3.5" />Revert
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-line bg-sunken/60 p-3">
          <p className="text-[12.5px] font-semibold text-ink">Review the revert</p>
          <pre className="mt-2 overflow-hidden rounded-md bg-terminal px-2.5 py-2 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap break-all text-ink-2">{'PATCH /zones/{zone_id}/rulesets/{ruleset_id}/rules/{rule_id}\n{ "action": "block" }'}</pre>
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
            <span className="rounded-md border border-line-strong px-2 py-1.5 font-mono text-[11.5px] text-muted">ops@example.com</span>
            <span className="rounded-md border border-line-strong px-2 py-1.5 font-mono text-[11.5px] text-muted">Global API Key ••••••••</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="inline-flex h-8 items-center rounded-[10px] bg-raised-2 px-3 text-[12px] text-ink-2">Send to Cloudflare</span>
            <button type="button" onClick={onBack} className="rounded px-1 text-[11.5px] text-muted underline-offset-4 hover:text-ink hover:underline">Back to the changes</button>
          </div>
          <p className="mt-2 text-[11px] text-faint">Admins and super admins only · the key is asked every time and never stored · demo: nothing is sent</p>
        </div>
      )}
    </div>
  );
}

function BackupScene({ phase, onStart }: { phase: Phase; onStart: () => void }) {
  const zones = [
    { name: 'example.com', n: 42 },
    { name: 'example.net', n: 27 },
    { name: 'shop.example.com', n: 19 },
  ];
  return (
    <div className="lp-scene">
      <Title meta="Production · R2 + S3">New backup</Title>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {zones.map((z, i) => (
          <li key={z.name} className="flex items-center gap-3 bg-sunken/60 px-3 py-2.5">
            <span className={cx('grid size-4 shrink-0 place-items-center rounded-[5px] border', i < 2 ? 'border-signal bg-signal text-signal-ink' : 'border-line-strong')}>
              {i < 2 && <Check aria-hidden="true" className="size-3" strokeWidth={3} />}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{z.name}</span>
            <span className="hidden font-mono text-[11px] text-faint sm:inline">{z.n} resources</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5"><Toggle on /> Upload to Cloudflare R2</span>
        <span className="inline-flex items-center gap-1.5"><Toggle on /> Upload to AWS S3</span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" data-tour="backup-start" onClick={onStart} disabled={phase === 'running'}
          className={cx('relative inline-flex h-9 min-w-36 items-center justify-center gap-2 overflow-hidden rounded-[10px] px-4 text-[13px] font-semibold transition-colors',
            phase === 'done' ? 'bg-ok/15 text-ok' : 'btn-gold')}>
          {phase === 'running' && <span aria-hidden="true" className="progress-live absolute inset-0 opacity-60" />}
          <span className="relative inline-flex items-center gap-2">
            {phase === 'done' ? <Check aria-hidden="true" className="size-4" /> : <CloudUpload aria-hidden="true" className="size-4" />}
            {phase === 'idle' ? 'Start backup' : phase === 'running' ? 'Backing up…' : 'Backup complete'}
          </span>
        </button>
        <span className="font-mono text-[11px] text-faint">{phase === 'done' ? 'r2://backups/Production_20261030_020000/' : '2 zones · Terraform + JSON'}</span>
      </div>
    </div>
  );
}

function Toggle({ on }: { on?: boolean }) {
  return (
    <span aria-hidden="true" className={cx('relative inline-block h-3.5 w-6 rounded-full', on ? 'bg-signal' : 'bg-raised-2')}>
      <span className={cx('absolute top-0.5 size-2.5 rounded-full bg-ink', on ? 'left-3' : 'left-0.5')} />
    </span>
  );
}

function RestoreScene({ phase, onCompare }: { phase: Phase; onCompare: () => void }) {
  const rows = [
    { addr: 'cloudflare_ruleset.http_request_firewall_custom', state: 'differs', from: 'action = "skip"', to: 'action = "block"' },
    { addr: 'cloudflare_dns_record.api_example_com', state: 'differs', from: 'proxied = false', to: 'proxied = true' },
    { addr: 'cloudflare_zone_setting.min_tls_version', state: 'matches', from: '', to: '' },
  ];
  return (
    <div className="lp-scene">
      <Title meta="backup 30 Oct · 02:00 UTC">Restore example.com</Title>
      {phase !== 'done' ? (
        <div className="grid place-items-start gap-3 rounded-xl border border-dashed border-line-strong p-4">
          <p className="max-w-sm text-[12.5px] text-muted">Imports every block of the backup and plans it against the live zone, read-only. Nothing changes until an apply.</p>
          <button type="button" data-tour="restore-compare" onClick={onCompare} disabled={phase === 'running'}
            className="relative inline-flex h-9 items-center gap-2 overflow-hidden rounded-[10px] border border-line-strong bg-raised px-4 text-[13px] font-medium text-ink hover:bg-raised-2">
            {phase === 'running' && <span aria-hidden="true" className="progress-live absolute inset-0 opacity-40" />}
            <span className="relative">{phase === 'running' ? 'Comparing with live zone…' : 'Find latest backup & compare'}</span>
          </button>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.addr} className="rounded-xl border border-line bg-sunken/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-2">{r.addr}</span>
                  <span className={cx('shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium', r.state === 'differs' ? 'bg-warn/12 text-warn' : 'bg-ok/12 text-ok')}>{r.state}</span>
                </div>
                {r.from && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11.5px]">
                    <span className="lp-del rounded px-1">{r.from}</span>
                    <ArrowRight aria-hidden="true" className="size-3 text-faint" />
                    <span className="lp-add rounded px-1">{r.to}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-3 font-mono text-[11.5px] text-muted">Plan: <span className="text-ink">2 to change</span>, 0 to add, 0 to delete · an admin&apos;s apply waits for a super admin</p>
        </>
      )}
    </div>
  );
}

function TrafficScene({ drill, onDrill, onBack }: { drill: boolean; onDrill: () => void; onBack: () => void }) {
  const bars = drill ? HOURS : DAYS;
  return (
    <div className="lp-scene">
      <Title meta={drill ? '17 Oct · per hour · UTC' : 'October · per day · UTC'}>Traffic · example.net</Title>
      <dl className="mb-3 grid grid-cols-3 gap-2">
        {(drill ? [['Requests', '2.9M'], ['Mitigated', '41.6k'], ['Top rule', 'Rate limit']] : [['Requests', '48.2M'], ['Cached', '71%'], ['Threats', '312k']]).map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line bg-sunken/60 px-2.5 py-2">
            <dt className="text-[10.5px] text-faint">{k}</dt>
            <dd className="truncate font-mono text-[13px] text-ink tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="relative flex h-32 items-end gap-[3px] rounded-xl border border-line bg-sunken/60 px-2 pt-3 pb-2 sm:h-36">
        {bars.map((h, i) => {
          const hot = drill ? i === 14 : i === SPIKE;
          const style = { height: `${h}%` };
          if (!drill && hot) {
            return (
              <button key={i} type="button" data-tour="traffic-spike" onClick={onDrill} aria-label="Open 17 October per hour"
                className="lp-bar is-hot flex-1 rounded-t-[3px]" style={style} />
            );
          }
          return <span key={i} aria-hidden="true" className={cx('lp-bar flex-1 rounded-t-[3px]', hot && 'is-hot')} style={style} />;
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-faint">
        <span className="font-mono">{drill ? '00:00' : '1 Oct'}</span>
        {drill
          ? <button type="button" onClick={onBack} className="rounded px-1 text-muted underline-offset-4 hover:text-ink hover:underline">Back to the month</button>
          : <span>Select the spike to open its day</span>}
        <span className="font-mono">{drill ? '23:00' : '30 Oct'}</span>
      </div>
    </div>
  );
}
