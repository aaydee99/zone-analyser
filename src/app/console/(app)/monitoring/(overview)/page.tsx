'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Bell, Play, Send } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { CHECKS, SEVERITIES, type MonitorOverview, type Severity } from '@/lib/monitor-types';
import type { MonitorConfigView } from '@/lib/monitor-config';
import type { SentNotification } from '@/lib/monitor-store';
import { Alert, Badge, Button, Card, Field, Loading, PageHeader, SectionHeader, Skeleton, SkeletonTable, cx } from '@/components/ui';
import { FindingList, SeverityBadge, when } from '@/components/monitor-view';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { runLabel, usePolled, type RunState } from '../use-run';

const LABELS = Object.fromEntries(CHECKS.map((c) => [c.id, c.label]));
const INTERVALS = [0, 1, 3, 6, 12, 24, 48, 168];
const every = (h: number) => (h === 0 ? 'Off (run by hand only)' : h === 1 ? 'Every hour' : h === 168 ? 'Every week' : h % 24 === 0 ? `Every ${h / 24} days` : `Every ${h} hours`);

export default function MonitoringOverview() {
  const { can } = useMe();
  const toast = useToast();
  const { data, error, reload } = usePolled<MonitorOverview & { run: RunState }>('/api/monitors');
  const [starting, setStarting] = useState(false);
  const manage = can('monitors:manage');

  const runAll = async () => {
    setStarting(true);
    try { await api('/api/monitors/run', { method: 'POST', json: {} }); toast('Running every check — each page fills in as its check finishes', 'info'); await reload(); }
    catch (err) { toast((err as Error).message, 'bad'); } finally { setStarting(false); }
  };

  const open = (s: Severity) => (data?.checks ?? []).reduce((n, c) => n + c.open[s], 0);
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Monitoring" title="What needs attention"
        description="Checks of every Cloudflare account and zone the stored tokens can reach: risks, expiring certificates, drift, failing services and more. New findings are sent to Slack or a webhook."
        actions={manage && <Button variant="primary" loading={starting || !!data?.run.running} onClick={runAll} icon={<Play className="size-4" />}>{data?.run.running ? 'Checking…' : 'Run all checks'}</Button>} />

      {error && !data && <Alert tone="bad" title="Monitoring could not be read">{error}</Alert>}
      {!data ? (
        <Loading label="Loading monitoring"><div className="grid gap-3 md:grid-cols-3">{Array.from({ length: 9 }, (_, i) => <Skeleton key={i} className="h-28 rounded-[14px]" />)}</div></Loading>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
            {(['critical', 'high', 'medium', 'low'] as Severity[]).map((s) => (
              <span key={s} className="inline-flex items-center gap-2"><SeverityBadge s={s} /><span className="font-mono tabular-nums text-ink-2">{open(s)}</span></span>
            ))}
            <span className="text-muted">
              {data.run.running ? runLabel(data.run, LABELS)
                : data.schedule.intervalHours ? `${every(data.schedule.intervalHours)} · last run ${data.schedule.lastRunAt ? relTime(data.schedule.lastRunAt) : 'never'}${data.schedule.nextRunAt ? ` · next ${when(data.schedule.nextRunAt)}` : ''}`
                  : 'Scheduled runs are off'}
            </span>
          </div>

          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.checks.map(({ meta, ranAt, error: err, open: counts, partial }) => {
              const worst = SEVERITIES.find((s) => s !== 'info' && counts[s] > 0);
              const total = SEVERITIES.reduce((n, s) => n + counts[s], 0);
              const now = data.run.running && data.run.current?.check === meta.id;
              return (
                <li key={meta.id}>
                  <Link href={`/console/monitoring/${meta.id}`} className={cx('panel group flex h-full flex-col gap-2 px-5 py-4 transition-colors hover:border-line-strong', worst === 'critical' || worst === 'high' ? 'border-bad/30' : worst === 'medium' ? 'border-warn/25' : '')}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[14.5px] font-semibold">{meta.label}</span>
                      <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink-2" />
                    </div>
                    <p className="line-clamp-2 text-[12.5px] text-muted">{meta.description}</p>
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                      {now ? <Badge tone="info">checking now</Badge>
                        : !ranAt ? <Badge>not checked yet</Badge>
                          : err ? <Badge tone="bad">last run failed</Badge>
                            : total === 0 ? <Badge tone="ok">nothing found</Badge>
                              : SEVERITIES.filter((s) => counts[s]).map((s) => <span key={s} className="inline-flex items-center gap-1"><SeverityBadge s={s} /><span className="font-mono text-[11px] text-ink-2">{counts[s]}</span></span>)}
                      {partial && <Badge tone="warn">partly read</Badge>}
                      {ranAt && <span className="ml-auto text-[11px] text-faint" title={fmtDate(ranAt)}>{relTime(ranAt)}</span>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>

          <section aria-labelledby="all-findings" className="space-y-2">
            <h2 id="all-findings" className="text-[15px] font-semibold">All open findings</h2>
            <FindingList findings={data.findings} canManage={manage} onChange={reload} showCheck empty={data.checks.some((c) => c.ranAt) ? 'No open findings — everything checked looks fine.' : 'Run the checks to see what needs attention.'} />
          </section>
        </>
      )}
      {can('settings:read') && <NotifySettings canEdit={manage} />}
    </div>
  );
}

function NotifySettings({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [cfg, setCfg] = useState<MonitorConfigView | null>(null);
  const [sent, setSent] = useState<SentNotification[]>([]);
  const [slack, setSlack] = useState('');
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api<{ config: MonitorConfigView; sent: SentNotification[] }>('/api/monitors/settings').then((r) => { setCfg(r.config); setSent(r.sent); }).catch(() => {});
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
      <SectionHeader title="Schedule and notifications" description="Checks run on the worker. New findings at or above the chosen severity are sent once to each address; a failed delivery is logged, never resent." />
      {!cfg ? <div className="p-5"><SkeletonTable rows={3} cols={3} /></div> : (
        <div className="grid gap-6 px-5 py-5 lg:grid-cols-2">
          <div className="space-y-4">
            <Field label="Run the checks" htmlFor="mon-interval" hint="The worker runs them while it is up; the GitHub schedule in the README starts it regularly.">
              <select id="mon-interval" className="input" value={cfg.intervalHours} disabled={!canEdit || !!busy} onChange={(e) => save({ intervalHours: Number(e.target.value) }, 'interval')}>
                {[...new Set([...INTERVALS, cfg.intervalHours])].sort((a, b) => a - b).map((h) => <option key={h} value={h}>{every(h)}</option>)}
              </select>
            </Field>
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
          </div>
          <div className="lg:col-span-2">
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
      )}
    </Card>
  );
}
