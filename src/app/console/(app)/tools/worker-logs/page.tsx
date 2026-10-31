'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, RefreshCw, Search, Square, Trash2 } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import {
  TAIL_METHODS, TAIL_MINUTES, TAIL_POLL_MS, TAIL_STATUSES, TAIL_VIEWER_IDLE_MS,
  type TailEntry, type TailFilters, type TailPoll, type TailSessionView, type TailStatus,
} from '@/lib/worker-tail-types';
import { Alert, Badge, Button, Card, Checkbox, Field, Loading, PageHeader, SectionHeader, Skeleton, cx } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Account { id: string; name: string }
interface Scripts { scripts: { name: string; modified: string | null }[]; from: 'stored' | 'live'; at: string | null }
/** Events kept in this tab (newest first); older ones drop off. */
const KEEP = 1_000;
const SAMPLING = [1, 0.5, 0.25, 0.1, 0.01];

const running = (s: TailSessionView | null) => !!s && (s.status === 'running' || s.status === 'starting');
const tone = (o: string) => (o === 'ok' ? 'ok' : o === 'canceled' ? 'neutral' : 'bad');
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Calls `fn` every `ms` while the tab is visible and `on`; at once when the tab shows again. */
function useVisiblePoll(on: boolean, ms: number, fn: () => Promise<void>) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);
  useEffect(() => {
    if (!on) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try { await fnRef.current(); } finally { if (!stopped) t = setTimeout(loop, ms); }
    };
    const onShow = () => { if (document.visibilityState === 'visible') { clearTimeout(t); void loop(); } else clearTimeout(t); };
    t = setTimeout(loop, ms);
    document.addEventListener('visibilitychange', onShow);
    return () => { stopped = true; clearTimeout(t); document.removeEventListener('visibilitychange', onShow); };
  }, [on, ms]);
}

function EventRow({ e }: { e: TailEntry }) {
  const detail = e.logs.length > 0 || e.exceptions.length > 0;
  const head = (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-mono text-[11.5px] text-faint tabular-nums">{clock(e.at)}</span>
      <Badge tone={tone(e.outcome)}>{e.outcome}</Badge>
      {e.method && <span className="font-mono text-[12px] text-ink-2">{e.method}</span>}
      {e.status !== undefined && <span className={cx('font-mono text-[12px] tabular-nums', e.status >= 500 ? 'text-bad' : e.status >= 400 ? 'text-warn' : 'text-ok')}>{e.status}</span>}
      <span className="min-w-0 truncate font-mono text-[12px] text-ink" title={e.url ?? e.trigger}>{e.url ?? `${e.kind}${e.trigger ? ` · ${e.trigger}` : ''}`}</span>
      {e.colo && <span className="font-mono text-[11px] text-faint">{e.colo}</span>}
      {detail && <span className="text-[11px] text-muted">{e.logs.length ? `${e.logs.length} log${e.logs.length === 1 ? '' : 's'}` : ''}{e.exceptions.length ? `${e.logs.length ? ' · ' : ''}${e.exceptions.length} exception${e.exceptions.length === 1 ? '' : 's'}` : ''}</span>}
    </span>
  );
  if (!detail) return <li className="border-b border-line/60 px-5 py-2 last:border-0">{head}</li>;
  return (
    <li className="border-b border-line/60 last:border-0">
      <details>
        <summary className="cursor-pointer list-none px-5 py-2 hover:bg-raised/40">{head}</summary>
        <div className="space-y-1 bg-sunken/50 px-5 py-3 font-mono text-[12px]">
          {e.exceptions.map((x, i) => <p key={`x${i}`} className="whitespace-pre-wrap break-words text-bad">{x.name}: {x.message}</p>)}
          {e.logs.map((l, i) => (
            <p key={i} className={cx('whitespace-pre-wrap break-words', l.level === 'error' ? 'text-bad' : l.level === 'warn' ? 'text-warn' : 'text-ink-2')}>
              <span className="mr-2 text-faint">{l.level}</span>{l.text}
            </p>
          ))}
          {e.cut && <p className="text-faint">…more logs were left out</p>}
        </div>
      </details>
    </li>
  );
}

export default function WorkerLogsPage() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [scripts, setScripts] = useState<Scripts | null>(null);
  const [scriptsBusy, setScriptsBusy] = useState(false);
  const [script, setScript] = useState('');
  const [status, setStatus] = useState<TailStatus[]>([]);
  const [methods, setMethods] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [sampling, setSampling] = useState(1);
  const [session, setSession] = useState<TailSessionView | null>(null);
  const [events, setEvents] = useState<TailEntry[]>([]);
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const next = useRef(0);
  const sessionRef = useRef<TailSessionView | null>(null);
  useEffect(() => { sessionRef.current = session; }, [session]);

  useEffect(() => {
    api<{ accounts: Account[]; current: TailSessionView | null }>('/api/tools/worker-logs').then((r) => {
      setAccounts(r.accounts);
      if (r.current && running(r.current)) {
        setSession(r.current); setAccountId(r.current.accountId); setScript(r.current.script);
        setStatus(r.current.filters.status); setMethods(r.current.filters.methods); setSearch(r.current.filters.search); setSampling(r.current.filters.sampling);
      } else setAccountId((a) => a || r.accounts[0]?.id || '');
    }).catch((e) => setError((e as Error).message));
  }, []);

  const loadScripts = useCallback(async (fresh = false) => {
    if (!accountId) return;
    setScriptsBusy(true);
    try {
      const r = await api<Scripts>(`/api/tools/worker-logs/scripts?accountId=${encodeURIComponent(accountId)}${fresh ? '&fresh=1' : ''}`);
      setScripts(r);
      setScript((s) => (r.scripts.some((x) => x.name === s) ? s : r.scripts[0]?.name ?? ''));
    } catch (e) { toast((e as Error).message, 'bad'); setScripts({ scripts: [], from: 'stored', at: null }); } finally { setScriptsBusy(false); }
  }, [accountId, toast]);
  useEffect(() => { setScripts(null); void loadScripts(false); }, [loadScripts]);

  const poll = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      const r = await api<TailPoll>(`/api/tools/worker-logs/sessions/${s.id}?after=${next.current}`);
      next.current = r.next;
      setSession(r.session);
      if (r.items.length) setEvents((list) => [...r.items.reverse(), ...list].slice(0, KEEP));
    } catch (e) { setError((e as Error).message); setSession((x) => (x ? { ...x, status: 'stopped', reason: (e as Error).message } : x)); }
  }, []);
  useVisiblePoll(running(session), TAIL_POLL_MS, poll);

  // Leaving the page ends the session at once (the server would after TAIL_VIEWER_IDLE_MS anyway).
  useEffect(() => {
    const leave = () => {
      const s = sessionRef.current;
      if (s && running(s)) void fetch(`/api/tools/worker-logs/sessions/${s.id}/stop`, { method: 'POST', keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); leave(); };
  }, []);

  const start = async () => {
    setBusy(true); setError('');
    try {
      const filters: TailFilters = { status, methods, search: search.trim(), sampling };
      const r = await api<{ session: TailSessionView }>('/api/tools/worker-logs/sessions', { method: 'POST', json: { accountId, script, filters } });
      next.current = 0;
      setEvents([]);
      setSession(r.session);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!session) return;
    setBusy(true);
    try { const r = await api<{ session: TailSessionView }>(`/api/tools/worker-logs/sessions/${session.id}/stop`, { method: 'POST' }); setSession(r.session); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };

  const live = running(session);
  const shown = useMemo(() => {
    const t = find.trim().toLowerCase();
    if (!t) return events;
    return events.filter((e) => `${e.url ?? ''} ${e.trigger ?? ''} ${e.method ?? ''} ${e.status ?? ''} ${e.outcome} ${e.logs.map((l) => l.text).join(' ')} ${e.exceptions.map((x) => `${x.name} ${x.message}`).join(' ')}`.toLowerCase().includes(t));
  }, [events, find]);
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Tools" title="Worker logs"
        description={`Follow a Worker’s requests, console.log lines and exceptions as they happen. A session stops after ${TAIL_MINUTES} minutes, when you stop it, or when this page is closed or hidden for ${Math.round(TAIL_VIEWER_IDLE_MS / 1000)} seconds. Events are kept only while it runs.`} />
      {error && <Alert tone="bad">{error}</Alert>}
      <Card>
        <SectionHeader step="1" title="Worker" description={scripts?.at ? `Workers as ${scripts.from === 'stored' ? 'monitoring last read them' : 'read just now'}, ${fmtDate(scripts.at)}` : undefined}
          aside={<Button size="sm" variant="ghost" onClick={() => loadScripts(true)} loading={scriptsBusy} disabled={!accountId || live} icon={<RefreshCw className="size-3.5" />}>Read from Cloudflare</Button>} />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          {!accounts ? <Loading label="Loading accounts"><Skeleton className="h-10 w-full rounded-[9px]" /></Loading> : (
            <Field label="Account">
              <select className="input" value={accountId} disabled={live} onChange={(e) => setAccountId(e.target.value)}>
                {!accounts.length && <option value="">No account reachable</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          )}
          {!scripts ? <Loading label="Loading Workers"><Skeleton className="h-10 w-full rounded-[9px]" /></Loading> : (
            <Field label="Worker" hint={!scripts.scripts.length ? 'No Workers stored for this account — read them from Cloudflare.' : undefined}>
              <select className="input font-mono" value={script} disabled={live} onChange={(e) => setScript(e.target.value)}>
                {!scripts.scripts.length && <option value="">—</option>}
                {scripts.scripts.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </Field>
          )}
        </div>
      </Card>
      <Card>
        <SectionHeader step="2" title="Filters" description="Cloudflare applies them before sending events. Changing them needs a new session." />
        <div className="grid gap-5 px-5 py-4 lg:grid-cols-2">
          <fieldset disabled={live}>
            <legend className="mb-2 text-[13px] font-medium text-ink-2">Outcome</legend>
            <div className="flex flex-wrap gap-4">
              {TAIL_STATUSES.map((s) => <Checkbox key={s.value} checked={status.includes(s.value)} disabled={live} onChange={(on) => setStatus((l) => toggle(l, s.value, on))} label={s.label} />)}
            </div>
          </fieldset>
          <fieldset disabled={live}>
            <legend className="mb-2 text-[13px] font-medium text-ink-2">Method</legend>
            <div className="flex flex-wrap gap-4">
              {TAIL_METHODS.map((m) => <Checkbox key={m} checked={methods.includes(m)} disabled={live} onChange={(on) => setMethods((l) => toggle(l, m, on))} label={<span className="font-mono text-[12px]">{m}</span>} />)}
            </div>
          </fieldset>
          <Field label="Log text contains" hint="Matches console.log messages" optional>
            <input className="input" value={search} disabled={live} maxLength={200} onChange={(e) => setSearch(e.target.value)} />
          </Field>
          <Field label="Sampling" hint="The share of events Cloudflare sends — lower it for busy Workers">
            <select className="input" value={sampling} disabled={live} onChange={(e) => setSampling(Number(e.target.value))}>
              {SAMPLING.map((s) => <option key={s} value={s}>{s * 100}%</option>)}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-[13px] text-muted" aria-live="polite">
            {session ? (live
              ? <>Following <span className="font-mono text-ink-2">{session.script}</span> · stops by {clock(session.expiresAt)} · {session.events.toLocaleString()} events{session.dropped ? ` · ${session.dropped.toLocaleString()} left out (too many per second — lower the sampling)` : ''}</>
              : <>Stopped{session.reason ? `: ${session.reason}` : ''}.</>) : 'Not running.'}
          </p>
          {live
            ? <Button variant="danger" onClick={stop} loading={busy} icon={<Square className="size-4" />}>Stop</Button>
            : <Button variant="primary" onClick={start} loading={busy} disabled={!accountId || !script} icon={<Play className="size-4" />}>Start</Button>}
        </div>
      </Card>
      <Card>
        <SectionHeader title="Events" description={events.length ? `${events.length.toLocaleString()} in this tab, newest first` : undefined} aside={(
          <div className="flex items-center gap-2">
            <label className="relative block w-48 sm:w-60">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
              <input className="input !py-1.5 !pl-8 !text-[13px]" placeholder="Search events" aria-label="Search events" value={find} onChange={(e) => setFind(e.target.value)} />
            </label>
            <Button size="sm" variant="ghost" onClick={() => setEvents([])} disabled={!events.length} icon={<Trash2 className="size-3.5" />}>Clear</Button>
          </div>
        )} />
        {!shown.length
          ? <p className="px-5 py-10 text-center text-sm text-muted">{live ? 'Waiting for requests to the Worker…' : find ? 'Nothing matches.' : 'Start a session to see events.'}</p>
          : <ul className="max-h-[70vh] overflow-y-auto">{shown.map((e) => <EventRow key={e.seq} e={e} />)}</ul>}
      </Card>
    </div>
  );
}
