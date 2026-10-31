'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { TIMELINE_WINDOWS, type TimelineEvent, type TimelineKind, type TimelineReport, type TimelineSeries } from '@/lib/investigate-types';
import { Alert, Badge, Card, EmptyState, Field, PageHeader, SectionHeader, cx } from '@/components/ui';
import { RefreshBar, Reading, ZonePicker, useJob, whole, type PickedZone } from '../shared';

const KIND_LABEL: Record<TimelineKind, string> = { config: 'Config change', spike: 'Traffic spike', worker: 'Worker', pages: 'Pages', certificate: 'Certificate', alert: 'Cloudflare alert', finding: 'Monitoring' };
const KIND_COLOR: Record<TimelineKind, string> = { config: 'bg-info', spike: 'bg-bad', worker: 'bg-signal', pages: 'bg-signal', certificate: 'bg-warn', alert: 'bg-warn', finding: 'bg-muted' };
const SERIES_COLOR: Record<TimelineSeries['key'], string> = { requests: 'fill-signal/70', '5xx': 'fill-bad', '4xx': 'fill-warn', blocked: 'fill-info' };
const windowLabel = (h: number) => (h < 24 ? `Last ${h} hours` : h === 24 ? 'Last 24 hours' : `Last ${h / 24} days`);

/** One series as bars on the shared time axis. */
function Strip({ s, since, until }: { s: TimelineSeries; since: number; until: number }) {
  const max = Math.max(1, ...s.points.map((p) => p.v));
  const span = until - since;
  const w = s.points.length ? 1000 / s.points.length : 0;
  const total = s.points.reduce((n, p) => n + p.v, 0);
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between text-[11.5px]"><span className="text-muted">{s.label}</span><span className="font-mono tabular-nums text-faint">{whole.format(total)} · peak {whole.format(max)}</span></div>
      <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="h-10 w-full rounded bg-raised/40" role="img" aria-label={`${s.label}: ${whole.format(total)} in the window, at most ${whole.format(max)} per bucket`}>
        {s.points.map((p) => {
          const x = ((Date.parse(p.t) - since) / span) * 1000;
          const h = (p.v / max) * 38;
          return p.v ? <rect key={p.t} x={x} y={40 - h} width={Math.max(1, w - 0.5)} height={h} className={SERIES_COLOR[s.key]}><title>{`${fmtDate(p.t)}: ${whole.format(p.v)}`}</title></rect> : null;
        })}
      </svg>
    </div>
  );
}

/** Event markers on the same axis. */
function Markers({ events, since, until }: { events: TimelineEvent[]; since: number; until: number }) {
  return (
    <div className="relative h-5" aria-hidden>
      {events.map((e, i) => {
        const left = Math.min(100, Math.max(0, ((Date.parse(e.at) - since) / (until - since)) * 100));
        return <span key={i} title={`${fmtDate(e.at)} — ${e.title}`} className={cx('absolute top-1 size-2.5 -translate-x-1/2 rounded-full ring-2 ring-surface', KIND_COLOR[e.kind])} style={{ left: `${left}%` }} />;
      })}
    </div>
  );
}

function Report({ r }: { r: TimelineReport }) {
  const kinds = useMemo(() => [...new Set(r.events.map((e) => e.kind))], [r.events]);
  const [off, setOff] = useState<Set<TimelineKind>>(new Set());
  const events = r.events.filter((e) => !off.has(e.kind));
  const since = Date.parse(r.since), until = Date.parse(r.until);
  return (
    <div className="space-y-4">
      <Card className="px-5 py-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-[12px] text-muted">
          <span>{fmtDate(r.since)} – {fmtDate(r.until)} · per {r.bucketMinutes < 60 ? `${r.bucketMinutes} minutes` : 'hour'}</span>
          <span className="flex flex-wrap gap-3">{kinds.map((k) => <span key={k} className="inline-flex items-center gap-1.5"><span className={cx('size-2 rounded-full', KIND_COLOR[k])} />{KIND_LABEL[k]}</span>)}</span>
        </div>
        <Markers events={events} since={since} until={until} />
        <div className="space-y-2">{r.series.map((s) => <Strip key={s.key} s={s} since={since} until={until} />)}</div>
        {!r.series.length && <p className="text-[13px] text-muted">No traffic series (see the sources below).</p>}
      </Card>
      <Card>
        <SectionHeader title="Events" description="Newest first. Spikes are buckets at least 3× the window's median and 6 robust deviations above it (and, for 4xx and 5xx, at least 2% of requests)."
          aside={(
            <div className="flex flex-wrap justify-end gap-1" role="group" aria-label="Show events of kind">
              {kinds.map((k) => (
                <button key={k} type="button" aria-pressed={!off.has(k)} onClick={() => setOff((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                  className={cx('rounded-md border px-2 py-0.5 text-[11.5px]', off.has(k) ? 'border-line text-faint' : 'border-line-strong bg-raised text-ink-2')}>{KIND_LABEL[k]}</button>
              ))}
            </div>
          )} />
        {!events.length ? <p className="px-5 py-6 text-sm text-muted">Nothing happened in this window that the console can see.</p> : (
          <ol className="divide-y divide-line/60">
            {events.map((e, i) => (
              <li key={i} className="grid gap-1 px-5 py-2.5 sm:grid-cols-[10rem_8rem_minmax(0,1fr)] sm:gap-3">
                <span className="font-mono text-[12px] text-muted">{fmtDate(e.at)}</span>
                <span><Badge tone={e.tone === 'bad' ? 'bad' : e.tone === 'warn' ? 'warn' : e.tone === 'ok' ? 'ok' : 'info'}>{KIND_LABEL[e.kind]}</Badge></span>
                <span className="min-w-0 text-[13px]">
                  {e.href ? <Link href={e.href} className="font-medium text-ink hover:underline">{e.title}</Link> : <span className="font-medium text-ink">{e.title}</span>}
                  {e.detail && <span className="block text-[12px] break-words text-muted">{e.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card>
        <SectionHeader title="Sources" />
        <ul className="divide-y divide-line/60 text-[13px]">
          {r.sources.map((s) => (
            <li key={s.key} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2">
              <span>{s.label}</span>
              <span className="text-muted"><Badge tone={s.status === 'ok' ? 'ok' : s.status === 'skipped' ? 'neutral' : 'warn'}>{s.status}</Badge>{s.status === 'ok' && <span className="ml-2">{whole.format(s.count)}</span>}{s.message && <span className="ml-2">{s.message}</span>}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function TimelineView({ initialZone, initialHours }: { initialZone: string; initialHours: number }) {
  const [zone, setZone] = useState<PickedZone | null>(null);
  const [hours, setHours] = useState((TIMELINE_WINDOWS as readonly number[]).includes(initialHours) ? initialHours : 24);
  useEffect(() => {
    if (!initialZone) return;
    api<{ zones: PickedZone[] }>(`/api/investigate/zones?limit=1&q=${encodeURIComponent(initialZone)}`).then((r) => { const z = r.zones.find((x) => x.id === initialZone); if (z) setZone(z); }).catch(() => undefined);
  }, [initialZone]);
  const path = zone ? `/api/investigate/timeline?zone=${encodeURIComponent(zone.id)}&hours=${hours}` : null;
  const job = useJob<TimelineReport>(path);
  // Keeps the address in step, so the page can be shared or reloaded.
  useEffect(() => {
    if (zone) window.history.replaceState(null, '', `/console/investigate/timeline?zone=${encodeURIComponent(zone.id)}&hours=${hours}`);
  }, [zone, hours]);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Investigate" title="Zone timeline"
        description="One time axis for a zone: configuration changes, 5xx / 4xx / blocked spikes, Worker and Pages deployments, certificates, Cloudflare alerts and monitoring findings — to see what changed just before something went wrong."
        actions={job.data ? <RefreshBar at={job.at} busy={job.busy} onRefresh={job.reload} generatedAt={job.data.generatedAt} /> : undefined} />
      <Card className="grid gap-4 px-5 py-5 md:grid-cols-[minmax(0,1fr)_12rem]">
        <ZonePicker label="Zone" value={zone} onChange={setZone} />
        <Field label="Window">
          <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{TIMELINE_WINDOWS.map((h) => <option key={h} value={h}>{windowLabel(h)}</option>)}</select>
        </Field>
      </Card>
      {job.error && <Alert tone="bad" title="Could not build the timeline">{job.error}</Alert>}
      {job.busy && !job.data && <Reading what="the timeline" pending={job.pending} />}
      {job.data && <Report r={job.data} />}
      {!zone && <Card><EmptyState icon={<History className="size-5" />} title="Choose a zone" description="Its timeline is built from the audit log cache, stored monitoring data and a few analytics queries, and kept for five minutes." /></Card>}
    </div>
  );
}
