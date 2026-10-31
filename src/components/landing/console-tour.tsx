'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Check, CloudUpload, Database, History, KeyRound, Pause, Play, Search, Undo2 } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import { useInView, usePageVisible, useReducedMotion } from './motion';
import { BrandMark } from '@/components/brand-mark';

// A working mock of the console, drawn in HTML: a cursor walks through a backup, a restore compare
// and a traffic drill-down, and the mock answers with its own toasts. Every zone, number and toast is
// sample data on example.com / example.net. Visitors can drive it themselves (it pauses the tour).

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Scene = 'backup' | 'restore' | 'traffic';
type Phase = 'idle' | 'running' | 'done';
interface Ping { id: number; title: string; detail: string }

const SCENES: { key: Scene; label: string; icon: typeof Database }[] = [
  { key: 'backup', label: 'Backups', icon: Database },
  { key: 'restore', label: 'Restore', icon: Undo2 },
  { key: 'traffic', label: 'Traffic', icon: Activity },
];
const DECOR = [
  { label: 'Cloudflare activity', icon: History },
  { label: 'Zone explorer', icon: Search },
  { label: 'Credentials', icon: KeyRound },
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

export function ConsoleTour() {
  const root = useRef<HTMLDivElement>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const onScreen = useInView(rootEl, { threshold: 0.35 });

  const [scene, setScene] = useState<Scene>('backup');
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

  useEffect(() => { setRootEl(root.current); }, []);
  // A visitor who wants motion starts from a clean slate; reduced motion keeps the finished state.
  useEffect(() => {
    if (reduced) return;
    setBackup('idle'); setCompare('idle'); setDrill(false); setScene('backup'); setStep(0);
  }, [reduced]);

  const ping = useCallback((title: string, detail: string) => {
    const id = ++pingId.current;
    setPings((p) => [...p.slice(-1), { id, title, detail }]);
    window.setTimeout(() => setPings((p) => p.filter((x) => x.id !== id)), 3600);
  }, []);

  const moveTo = useCallback((target: string) => {
    const box = root.current;
    const el = box?.querySelector<HTMLElement>(`[data-tour="${target}"]`);
    if (!box || !el) return;
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
    [2800, () => moveTo(nav('backup'))],
    [800, () => { press(); setScene('backup'); setBackup('idle'); setCompare('idle'); setDrill(false); }],
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

  const togglePause = () => {
    if (paused) {
      // Resume from the top of the current scene so the cursor never jumps mid-story.
      setScene('backup'); setBackup('idle'); setCompare('idle'); setDrill(false); setStep(0); setPaused(false);
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

        {/* Phone: the scenes as tabs */}
        <div className="flex gap-1 border-b border-line px-2 py-1.5 md:hidden">
          {SCENES.map(({ key, label, icon: Icon }) => (
            <button key={key} type="button" data-tour={`tab-${key}`} onClick={() => go(key)} aria-pressed={scene === key}
              className={cx('inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-[12.5px] transition-colors',
                scene === key ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}>
              <Icon aria-hidden="true" className="size-3.5" />{label}
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
          <p className="mt-3 font-mono text-[11.5px] text-muted">Plan: <span className="text-ink">2 to change</span>, 0 to add, 0 to delete · apply needs a super admin</p>
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
