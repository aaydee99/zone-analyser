'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Fingerprint, Search } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { RAY_WINDOWS, type Cell, type RayResult } from '@/lib/investigate-types';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, SectionHeader, cx } from '@/components/ui';
import { RefreshBar, Reading, ZonePicker, useAccounts, useJob, whole, type PickedZone } from '../shared';
import { compactNum } from '@/lib/num';

type Scope = 'zone' | 'host' | 'account' | 'all';
const SCOPES: { value: Scope; label: string; hint: string }[] = [
  { value: 'zone', label: 'A zone', hint: 'One query per day searched' },
  { value: 'host', label: 'A host name', hint: 'The zone it belongs to' },
  { value: 'account', label: 'An account', hint: '10 zones per query, busiest first' },
  { value: 'all', label: 'Every zone', hint: 'Stops at the query cap' },
];
const WINDOW_LABEL: Record<number, string> = { 1: 'Last hour', 6: 'Last 6 hours', 24: 'Last 24 hours', 72: 'Last 3 days', 168: 'Last 7 days' };

const show = (v: Cell | undefined) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'number' ? whole.format(v) : String(v));
const ACTION_TONE = (a: string): 'bad' | 'warn' | 'ok' | 'info' | 'neutral' => {
  const x = a.toLowerCase().replace(/[_\s]/g, '');
  if (/solved|bypassed/.test(x) || /^(allow|skip|bypass)$/.test(x)) return 'ok';
  if (/block|connectionclose/.test(x)) return 'bad';
  if (/challenge/.test(x)) return 'warn';
  return x === 'log' ? 'info' : 'neutral';
};

function Facts({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  return (
    <div>
      <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
      <dl className="space-y-1.5 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted">{k}</dt><dd className="font-mono text-[12.5px] break-all text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Result({ r }: { r: RayResult }) {
  const q = r.request ?? {};
  const e0 = r.events[0] ?? {};
  // The request when the plan keeps it; otherwise the security event says the same things.
  const v = (k: string) => q[k] ?? (e0 as Record<string, Cell>)[k];
  const s = r.search;
  return (
    <div className="space-y-4">
      <Card className="px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-mono text-lg font-semibold">{r.ray}</h2>
              {r.found ? <Badge tone="ok">found</Badge> : <Badge tone="warn">not found</Badge>}
            </div>
            {r.found && r.zone && <p className="mt-1 text-[13px] text-muted">{r.zone.name} · {r.zone.accountName} · {r.zone.plan} · {fmtDate(r.at)}</p>}
          </div>
          {r.found && r.zone && (
            <Link className="text-[13px] text-signal hover:underline" href={`/console/investigate/timeline?zone=${encodeURIComponent(r.zone.id)}`}>Zone timeline</Link>
          )}
        </div>
        <p className="mt-3 text-[12px] text-muted">
          Searched {whole.format(s.searched)} of {whole.format(s.zones)} zone{s.zones === 1 ? '' : 's'} from {fmtDate(s.since)} to {fmtDate(s.until)} in {s.queries} quer{s.queries === 1 ? 'y' : 'ies'} (cap {s.maxQueries}); {s.ranking}.
        </p>
        {s.capped && <div className="mt-3"><Alert tone="warn" title="The search stopped at its query cap">Not every zone of the scope was searched. Choose the zone, a host name or the account, or give the time of the request.</Alert></div>}
      </Card>

      {r.found && (
        <Card className="grid gap-6 px-5 py-5 md:grid-cols-2">
          <Facts title="Client" rows={[
            ['IP address', show(v('clientIP'))], ['Country', show(v('clientCountryName'))], ['Network (ASN)', `${show(v('clientAsn'))}${v('clientASNDescription') ? ` · ${v('clientASNDescription')}` : ''}`],
            ['User agent', show(v('userAgent'))],
            ...(q.botScore !== undefined ? [['Bot score', `${show(q.botScore)}${q.botScoreSrcName ? ` (${q.botScoreSrcName})` : ''}`] as [string, ReactNode]] : []),
          ]} />
          <Facts title="Request" rows={[
            ['Method', show(v('clientRequestHTTPMethodName'))], ['Host', show(v('clientRequestHTTPHost'))], ['Path', show(v('clientRequestPath'))], ['Query', show(v('clientRequestQuery'))],
            ['Protocol', show(v('clientRequestHTTPProtocol'))],
          ]} />
          <Facts title="Response" rows={[
            ['Edge status', show(v('edgeResponseStatus'))], ['Cache', show(q.cacheStatus)],
            ...(q.originResponseStatus !== undefined ? [['Origin status', show(q.originResponseStatus)] as [string, ReactNode]] : []),
            ...(q.originResponseDurationMs !== undefined ? [['Origin time', `${show(q.originResponseDurationMs)} ms`] as [string, ReactNode]] : []),
            ...(q.edgeTimeToFirstByteMs !== undefined ? [['Time to first byte', `${show(q.edgeTimeToFirstByteMs)} ms`] as [string, ReactNode]] : []),
            ...(q.edgeResponseBytes !== undefined ? [['Bytes', show(q.edgeResponseBytes)] as [string, ReactNode]] : []),
          ]} />
          <Facts title="Security" rows={r.events.length ? [
            ['Final action', <Badge key="a" tone={ACTION_TONE(String(q.securityAction ?? r.events.at(-1)?.action ?? ''))}>{show(q.securityAction ?? r.events.at(-1)?.action)}</Badge>],
            ['Source', show(q.securitySource ?? r.events.at(-1)?.source)],
            ['Events', `${compactNum(r.events.length)} logged`],
          ] : [['Security', 'No rule acted on this request (no security event)']]} />
        </Card>
      )}

      {r.events.length > 0 && (
        <Card>
          <SectionHeader title="What security did" description="Each security event for this Ray ID, in the order Cloudflare logged it." />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[12.5px]">
              <thead className="bg-raised/50 text-muted"><tr>{['Time', 'Action', 'Source', 'Rule', 'Ruleset', 'Description'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {r.events.map((e, i) => (
                  <tr key={i} className="border-t border-line/50 align-top">
                    <td className="px-4 py-2 font-mono whitespace-nowrap">{e.datetime.slice(11, 19)}</td>
                    <td className="px-4 py-2"><Badge tone={ACTION_TONE(e.action)}>{e.action}</Badge></td>
                    <td className="px-4 py-2">{e.source}</td>
                    <td className="px-4 py-2 font-mono break-all">{e.ruleId || '—'}</td>
                    <td className="px-4 py-2">{e.rulesetName ?? (e.rulesetId ? <span className="font-mono">{e.rulesetId}</span> : '—')}</td>
                    <td className="px-4 py-2 text-ink-2">{e.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {r.found && (
        <details className="panel px-5 py-3 text-[13px]">
          <summary className="cursor-pointer text-muted">Every field Cloudflare returned</summary>
          <div className="mt-3 grid gap-x-6 gap-y-1 font-mono text-[12px] md:grid-cols-2">
            {Object.entries({ ...e0, ...q }).map(([k, x]) => <div key={k} className="grid grid-cols-[13rem_minmax(0,1fr)] gap-2"><span className="text-muted">{k}</span><span className="break-all">{show(x as Cell)}</span></div>)}
          </div>
        </details>
      )}

      {r.notes.map((n) => <Alert key={n} tone="info">{n}</Alert>)}
      {r.failed.length > 0 && (
        <Alert tone="warn" title={`${r.failed.length} zone${r.failed.length === 1 ? '' : 's'} could not be searched`}>
          <ul className="mt-1 space-y-0.5">{r.failed.slice(0, 20).map((f) => <li key={f.zone}><span className="font-medium">{f.zone}</span>: {f.error}</li>)}</ul>
          {r.failed.length > 20 && <p className="mt-1">…and {r.failed.length - 20} more</p>}
        </Alert>
      )}
    </div>
  );
}

export function RayView({ initialRay, initialZone, initialHours, initialAt }: { initialRay: string; initialZone: string; initialHours: number; initialAt: string }) {
  const accounts = useAccounts();
  const [ray, setRay] = useState(initialRay);
  const [scope, setScope] = useState<Scope>('zone');
  const [zone, setZone] = useState<PickedZone | null>(null);
  const [host, setHost] = useState('');
  const [account, setAccount] = useState('');
  // A link may say how far back (and around when) to search; otherwise the last 24 hours.
  const linkHours = (RAY_WINDOWS as readonly number[]).includes(initialHours) ? initialHours : 24;
  const linkAt = initialAt && !Number.isNaN(Date.parse(initialAt)) ? new Date(initialAt).toISOString() : '';
  const [hours, setHours] = useState(linkHours);
  const [at, setAt] = useState(linkAt ? linkAt.slice(0, 16) : '');
  const [path, setPath] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const job = useJob<RayResult>(path);

  // Opened from a link with a zone: look it up once the zone is known.
  useEffect(() => {
    if (!initialZone) return;
    api<{ zones: PickedZone[] }>(`/api/investigate/zones?limit=1&q=${encodeURIComponent(initialZone)}`).then((r) => {
      const z = r.zones.find((x) => x.id === initialZone);
      if (!z) return;
      setZone(z);
      if (initialRay) setPath(`/api/investigate/ray?${new URLSearchParams({ ray: initialRay, zone: z.id, hours: String(linkHours), ...(linkAt ? { at: linkAt } : {}) })}`);
    }).catch(() => undefined);
  }, [initialZone, initialRay, linkHours, linkAt]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!/^[0-9a-f]{16}(-[a-z]{3,4})?$/i.test(ray.trim())) return setFormError('A Ray ID is 16 hex characters, optionally with the data center (8f3a1b2c4d5e6f70-AMS)');
    const p = new URLSearchParams({ ray: ray.trim(), hours: String(hours) });
    if (scope === 'zone') { if (!zone) return setFormError('Choose the zone'); p.set('zone', zone.id); }
    if (scope === 'host') { if (!host.trim()) return setFormError('Enter the host name (or the URL)'); p.set('host', host.trim()); }
    if (scope === 'account') { if (!account) return setFormError('Choose the account'); p.set('account', account); }
    if (scope === 'all') p.set('all', '1');
    if (at) p.set('at', new Date(`${at}:00Z`).toISOString());
    setPath(`/api/investigate/ray?${p}`);
  };

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Investigate" title="Ray ID lookup"
        description="Find the request behind a Ray ID — the one on a Cloudflare error or block page — and see who sent it, what it asked for, what it got, and which security rule acted on it. Read from Cloudflare's analytics (single requests and security events are kept about 31 days)."
        actions={job.data ? <RefreshBar at={job.at} busy={job.busy} onRefresh={job.reload} generatedAt={job.data.generatedAt} /> : undefined} />
      <Card className="px-5 py-5">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem_14rem]">
            <Field label="Ray ID"><input className="input font-mono" value={ray} onChange={(e) => setRay(e.target.value)} placeholder="8f3a1b2c4d5e6f70-AMS" spellCheck={false} autoComplete="off" /></Field>
            <Field label="Search">
              <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {RAY_WINDOWS.map((h) => <option key={h} value={h}>{at ? `${h} hours around it` : WINDOW_LABEL[h]}</option>)}
              </select>
            </Field>
            <Field label="About when (UTC)" optional hint="Centres the search on this time"><input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
          </div>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Where to look</legend>
            <div className="grid gap-2 sm:grid-cols-4">
              {SCOPES.map((o) => (
                <label key={o.value} className={cx('cursor-pointer rounded-xl border px-3 py-2.5 transition-colors', scope === o.value ? 'border-signal/60 bg-signal/[0.07]' : 'border-line bg-sunken/60 hover:border-line-strong')}>
                  <span className="flex items-center gap-2 text-sm font-medium"><input type="radio" name="scope" value={o.value} checked={scope === o.value} onChange={() => setScope(o.value)} className="accent-[var(--color-signal)]" />{o.label}</span>
                  <span className="mt-0.5 block pl-5 text-xs text-muted">{o.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {scope === 'zone' && <ZonePicker label="Zone" value={zone} onChange={setZone} />}
          {scope === 'host' && <Field label="Host name or URL"><input className="input font-mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="www.example.com" spellCheck={false} /></Field>}
          {scope === 'account' && (
            <Field label="Account">
              <select className="input" value={account} onChange={(e) => setAccount(e.target.value)}>
                <option value="">{accounts ? 'Choose an account' : 'Loading accounts…'}</option>
                {(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name} ({whole.format(a.zones)} zones)</option>)}
              </select>
            </Field>
          )}
          {scope === 'all' && <Alert tone="info">Every zone is searched 10 at a time, busiest first, newest day first, until the Ray ID is found or the query cap is reached. Knowing the zone, the host or the account is much faster.</Alert>}
          {formError && <p className="text-[13px] text-bad" role="alert">{formError}</p>}
          <Button type="submit" variant="primary" icon={<Search className="size-4" />} loading={job.busy}>Look up</Button>
        </form>
      </Card>
      {job.error && <Alert tone="bad" title="The lookup failed">{job.error}</Alert>}
      {job.busy && !job.data && <Reading what="the Ray ID" pending={job.pending} />}
      {job.data && <Result r={job.data} />}
      {!path && !job.data && <Card><EmptyState icon={<Fingerprint className="size-5" />} title="Paste a Ray ID" description="Say where to look — the zone or host is fastest. The Ray ID alone does not tell which zone it belongs to." /></Card>}
    </div>
  );
}
