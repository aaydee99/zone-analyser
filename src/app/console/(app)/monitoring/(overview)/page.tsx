'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Bell, Play, RefreshCw, Send } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { CHECKS, SEVERITIES, type CheckId, type MonitorOverview, type QueueView, type Severity } from '@/lib/monitor-types';
import type { MonitorConfigView } from '@/lib/monitor-config';
import type { SentNotification } from '@/lib/monitor-store';
import { Alert, Badge, Button, Card, Field, Loading, PageHeader, SectionHeader, Skeleton, SkeletonTable, Switch, cx } from '@/components/ui';
import { FindingList, SeverityBadge } from '@/components/monitor-view';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { coverageLabel, every, useSnapshot } from '../use-run';

const INTERVALS = [0.25, 0.5, 1, 3, 6, 12, 24, 48, 168];
import { whole } from '@/lib/num';

export default function MonitoringOverview() {
  const { can } = useMe();
  const toast = useToast();
  const { data, error, loading, reload, version } = useSnapshot<MonitorOverview>('/api/monitors');
  const [starting, setStarting] = useState(false);
  const manage = can('monitors:manage');

  const runAll = async () => {
    setStarting(true);
    try {
      const r = await api<{ units: number }>('/api/monitors/run', { method: 'POST', json: {} });
      toast(`Checking ${whole.format(r.units)} zones and accounts now, before scheduled work — press Refresh to see what is done`, 'info');
      await reload();
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setStarting(false); }
  };

  const open = (s: Severity) => (data?.checks ?? []).reduce((n, c) => n + c.open[s], 0);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, open(s)])) as Record<Severity, number>;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Monitoring" title="What needs attention"
        description="Checks of every Cloudflare account and zone the stored tokens can reach: risks, expiring certificates, drift, failing services and more. New findings are sent to Slack or a webhook."
        actions={<>
          <Button variant="ghost" loading={loading && !!data} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {manage && <Button variant="primary" loading={starting} onClick={runAll} icon={<Play className="size-4" />}>Run all checks</Button>}
        </>} />

      {error && <Alert tone="bad" title="Monitoring could not be read">{error}</Alert>}
      {!data ? (
        <Loading label="Loading monitoring"><div className="grid gap-3 md:grid-cols-3">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-28 rounded-[14px]" />)}</div></Loading>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
            {(['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => (
              <span key={s} className="inline-flex items-center gap-2"><SeverityBadge s={s} /><span className="font-mono tabular-nums text-ink-2">{whole.format(counts[s])}</span></span>
            ))}
            <span className="text-muted"><QueueLine q={data.queue} /></span>
            <span className="ml-auto text-[12px] text-faint" title={fmtDate(data.generatedAt)}>As of {new Date(data.generatedAt).toLocaleTimeString()}</span>
          </div>
          {data.queue.note && <Alert tone="warn" title="Monitoring is waiting">{data.queue.note}</Alert>}

          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.checks.map(({ meta, coverage, open: c, interval }) => {
              const worst = SEVERITIES.find((s) => s !== 'info' && c[s] > 0);
              const total = SEVERITIES.reduce((n, s) => n + c[s], 0);
              return (
                <li key={meta.id}>
                  <Link href={`/console/monitoring/${meta.id}`} className={cx('panel group flex h-full flex-col gap-2 px-5 py-4 transition-colors hover:border-line-strong', worst === 'critical' || worst === 'high' ? 'border-bad/30' : worst === 'medium' ? 'border-warn/25' : '')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[14.5px] font-semibold">{meta.label}</span>
                      <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink-2" />
                    </div>
                    <p className="line-clamp-2 text-[12.5px] text-muted">{meta.description}</p>
                    <p className="text-[11.5px] text-faint">{coverageLabel(coverage)} · {every(interval).toLowerCase()}</p>
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                      {!coverage.lastRun ? <Badge>not checked yet</Badge>
                        : total === 0 ? <Badge tone="ok">nothing found</Badge>
                          : SEVERITIES.filter((s) => c[s]).map((s) => <span key={s} className="inline-flex items-center gap-1"><SeverityBadge s={s} /><span className="font-mono text-[11px] text-ink-2">{whole.format(c[s])}</span></span>)}
                      {coverage.failing > 0 && <Badge tone="warn">{whole.format(coverage.failing)} failing</Badge>}
                      {coverage.lastRun && <span className="ml-auto text-[11px] text-faint" title={fmtDate(coverage.lastRun)}>{relTime(coverage.lastRun)}</span>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>

          <section aria-labelledby="all-findings" className="space-y-2">
            <h2 id="all-findings" className="text-[15px] font-semibold">All open findings</h2>
            <FindingList counts={counts} canManage={manage} version={version} showCheck empty={data.checks.some((c) => c.coverage.lastRun) ? 'No open findings — everything checked looks fine.' : 'Run the checks to see what needs attention.'} />
          </section>

          <Lanes q={data.queue} />
        </>
      )}
      {can('settings:read') && <NotifySettings canEdit={manage} />}
    </div>
  );
}

function QueueLine({ q }: { q: QueueView }) {
  if (q.running || q.due) return <>Checking · {whole.format(q.running)} running, {whole.format(q.due)}{q.due >= 500 ? '+' : ''} waiting</>;
  return <>{q.scheduled ? 'Up to date — each check runs again at its own interval' : 'Scheduled checks are off — checks run when started by hand'}</>;
}

/** Each API token's share of Cloudflare's rate limit, as monitoring uses it. */
function Lanes({ q }: { q: QueueView }) {
  if (!q.lanes.length) return null;
  return (
    <Card>
      <SectionHeader title="API tokens" description={`Each token is checked side by side, with at most ${whole.format(q.lanes[0].budget)} monitoring calls per 5 minutes of Cloudflare’s 1,200. A token a backup or restore is using gets none until it is done.${q.discoveredAt ? ` Accounts and zones listed ${relTime(q.discoveredAt)}.` : ''}`} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead><tr className="border-b border-line text-muted">{['Token', 'Accounts', 'Zones', 'Calls (5 min)', 'Running', 'Status'].map((h) => <th key={h} className="px-5 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}</tr></thead>
          <tbody>
            {q.lanes.map((l) => (
              <tr key={l.name} className="border-b border-line/60 last:border-0">
                <td className="px-5 py-2.5 text-ink">{l.name}</td>
                <td className="px-5 py-2.5 font-mono tabular-nums text-ink-2">{whole.format(l.accounts)}</td>
                <td className="px-5 py-2.5 font-mono tabular-nums text-ink-2">{whole.format(l.zones)}</td>
                <td className="px-5 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-signal" style={{ width: `${Math.min(100, (l.used / l.budget) * 100)}%` }} /></div>
                    <span className="font-mono text-[11.5px] tabular-nums text-muted">{whole.format(l.used)} / {whole.format(l.budget)}</span>
                  </div>
                </td>
                <td className="px-5 py-2.5 font-mono tabular-nums text-ink-2">{l.running}</td>
                <td className="px-5 py-2.5">{l.paused ? <Badge tone="warn">{l.paused}</Badge> : <Badge tone="ok">ready</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function NotifySettings({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [cfg, setCfg] = useState<MonitorConfigView | null>(null);
  const [sent, setSent] = useState<SentNotification[]>([]);
  const [slack, setSlack] = useState('');
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState('');
  const [loadError, setLoadError] = useState('');
  const load = () => api<{ config: MonitorConfigView; sent: SentNotification[] }>('/api/monitors/settings').then((r) => { setCfg(r.config); setSent(r.sent); setLoadError(''); }).catch((e) => setLoadError((e as Error).message));
  useEffect(() => { void load(); }, []);

  const save = async (patch: Record<string, unknown>, what: string) => {
    setBusy(what);
    try {
      const r = await api<{ config: MonitorConfigView }>('/api/monitors/settings', { method: 'PUT', json: patch });
      setCfg(r.config);
      if ('slack' in patch) setSlack('');
      if ('webhook' in patch) setHook('');
      toast('Saved', 'ok');
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(''); }
  };
  const test = async (channel: 'slack' | 'webhook') => {
    setBusy(`test:${channel}`);
    try { await api('/api/monitors/settings/test', { method: 'POST', json: { channel } }); toast('Test message sent', 'ok'); void load(); }
    catch (err) { toast((err as Error).message, 'bad'); void load(); } finally { setBusy(''); }
  };

  return (
    <Card>
      <SectionHeader title="Schedule and notifications" description="Checks run on the worker, each at its own interval. New findings at or above the chosen severity are sent once to each address, in one message every few minutes at most; a failed delivery is logged, never resent." />
      {!cfg && loadError ? <div className="p-5"><Alert tone="bad" title="The monitoring settings could not be read">{loadError}</Alert></div> : !cfg ? <div className="p-5"><SkeletonTable rows={3} cols={3} /></div> : (
        <div className="grid gap-6 px-5 py-5 lg:grid-cols-2">
          <div className="space-y-4">
            <Switch checked={cfg.scheduled} disabled={!canEdit || !!busy} onChange={(v) => save({ scheduled: v }, 'scheduled')} label="Run the checks on their own (on the worker, while it is up)" />
            <div className={cx('space-y-2', !cfg.scheduled && 'opacity-60')}>
              {CHECKS.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor={`every-${c.id}`} className="min-w-0 flex-1 text-[13px]">
                    <span className="text-ink-2">{c.label}</span>
                    <span className="block text-[11.5px] text-faint">{c.unit}</span>
                  </label>
                  <select id={`every-${c.id}`} className="input !w-auto !py-1.5 !text-[13px]" value={cfg.intervals[c.id]} disabled={!canEdit || !!busy} onChange={(e) => save({ intervals: { [c.id]: Number(e.target.value) } as Partial<Record<CheckId, number>> }, `every:${c.id}`)}>
                    {[...new Set([...INTERVALS, cfg.intervals[c.id]])].sort((a, b) => a - b).map((h) => <option key={h} value={h}>{every(h)}{h === c.every ? ' (default)' : ''}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <Field label="Send findings from" htmlFor="mon-sev">
              <select id="mon-sev" className="input" value={cfg.minSeverity} disabled={!canEdit || !!busy} onChange={(e) => save({ minSeverity: e.target.value }, 'severity')}>
                {SEVERITIES.map((s) => <option key={s} value={s}>{s === 'info' ? 'Everything' : `${s[0].toUpperCase()}${s.slice(1)} and above`}</option>)}
              </select>
            </Field>
          </div>
          <div className="space-y-4">
            {([['slack', 'Slack', slack, setSlack, 'https://hooks.slack.com/services/…', 'An incoming-webhook address from your Slack workspace.'],
              ['webhook', 'Webhook', hook, setHook, 'https://alerts.example.com/hooks/castellan', 'Receives a JSON message for each batch of findings (Teams, PagerDuty, your own service).']] as const).map(([key, label, value, set, ph, hint]) => {
              const on = cfg[key];
              return (
                <Field key={key} label={label} htmlFor={`mon-${key}`} hint={on.set ? <>Set ({on.hint}). Enter a new address to replace it.</> : hint}>
                  <div className="flex flex-wrap gap-2">
                    <input id={`mon-${key}`} className="input min-w-0 flex-1 font-mono !text-[12.5px]" type="url" placeholder={on.set ? `Saved address ${on.hint}` : ph} value={value} disabled={!canEdit} onChange={(e) => set(e.target.value)} autoComplete="off" />
                    {canEdit && <Button disabled={!value.trim()} loading={busy === key} onClick={() => save({ [key]: value.trim() }, key)}>Save</Button>}
                    {canEdit && on.set && <Button variant="ghost" loading={busy === `test:${key}`} onClick={() => test(key)} icon={<Send className="size-3.5" />}>Send a test</Button>}
                    {canEdit && on.set && <Button variant="ghost" loading={busy === `rm:${key}`} onClick={() => save({ [key]: null }, `rm:${key}`)}>Remove</Button>}
                  </div>
                </Field>
              );
            })}
            <div>
              <div className="eyebrow mb-2 flex items-center gap-2"><Bell className="size-3.5" />Recently sent</div>
              {sent.length === 0 ? <p className="text-[13px] text-muted">Nothing sent yet.</p> : (
                <ul className="divide-y divide-line/60 rounded-xl border border-line text-[12.5px]">
                  {sent.slice(0, 8).map((n) => (
                    <li key={n.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <Badge tone={n.ok ? 'ok' : 'bad'}>{n.ok ? 'delivered' : 'failed'}</Badge>
                      <span className="capitalize text-ink-2">{n.channel}</span>
                      <span className="min-w-0 flex-1 truncate text-muted">{n.subject}{n.error ? ` — ${n.error}` : ''}</span>
                      <span className="text-faint" title={fmtDate(n.sentAt)}>{relTime(n.sentAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
