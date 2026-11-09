'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, KeyRound } from 'lucide-react';
import { fmtDate } from '@/lib/client';
import { LEAKED_WINDOWS, type LeakedReport, type LeakedZone } from '@/lib/investigate-types';
import { CREDENTIAL_FIELDS, answeredOk, isChecked, resultOf, stops } from '@/lib/leaked-creds-score';
import { actionLabel } from '@/lib/waf-labels';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, SectionHeader, Stat, cx } from '@/components/ui';
import { Code, RefreshBar, Reading, ZonePicker, useAccounts, useJob, whole, type PickedZone } from '../shared';

const PAGE = 5;
const exact = (n: number) => n.toLocaleString('en-US');
const share = (n: number, of: number) => (of ? `${(Math.round((n / of) * 1000) / 10).toFixed(1)}%` : '—');
const TONE = { bad: 'bad', warn: 'warn', info: 'neutral', ok: 'ok', neutral: 'neutral' } as const;

/** A table of counts with each row's share of `of`. */
function Counts({ title, sub, head, rows, of }: { title: string; sub?: string; head: string[]; rows: { key: string; cells: ReactNode[]; count: number }[]; of: number }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-[12px] font-semibold text-ink-2">{title}</h4>
      {sub && <p className="mb-1.5 text-[11.5px] text-faint">{sub}</p>}
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead><tr className="text-left text-[11px] text-faint">{[...head, 'Requests', 'Share'].map((h, i) => <th key={h} className={cx('py-1 pr-2 font-medium', i >= head.length && 'text-right')}>{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line align-top">
                  {r.cells.map((c, i) => <td key={i} className="py-1 pr-2 break-words [overflow-wrap:anywhere]">{c}</td>)}
                  <td className="py-1 pr-2 text-right font-mono whitespace-nowrap tabular-nums text-ink">{exact(r.count)}</td>
                  <td className="py-1 text-right font-mono whitespace-nowrap tabular-nums text-muted">{share(r.count, of)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-[12px] text-muted">None.</p>}
    </div>
  );
}

function Result({ v }: { v: string }) {
  const r = resultOf(v);
  return <Badge tone={TONE[r.tone]}>{r.label}</Badge>;
}

function Zone({ z }: { z: LeakedZone }) {
  const c = z.config, t = z.traffic;
  const checked = t ? t.results.filter((r) => isChecked(r.result)).reduce((s, r) => s + r.count, 0) : 0;
  const total = t ? t.results.reduce((s, r) => s + r.count, 0) : 0;
  const okCount = t ? t.byStatus.filter((r) => answeredOk(r.status)).reduce((s, r) => s + r.count, 0) : 0;
  const stopped = t?.byAction ? t.byAction.filter((r) => stops(r.action)).reduce((s, r) => s + r.count, 0) : null;
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold break-words">{z.zoneName}</span>
            {z.plan && <Badge>{z.plan}</Badge>}
            <Badge tone={c?.enabled ? 'ok' : c?.enabled === false ? 'bad' : 'neutral'}>{c?.enabled ? 'detection on' : c?.enabled === false ? 'detection off' : 'detection not read'}</Badge>
          </div>
          {z.message && <p className="mt-1 text-[12.5px] break-words text-muted">{z.message}</p>}
        </div>
        {t && <p className="text-[12px] text-faint">{fmtDate(t.since)} – {fmtDate(t.until)}</p>}
      </div>

      {z.findings.length > 0 && (
        <div className="border-b border-line px-5 py-4">
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Findings</h3>
          <ul className="space-y-3">
            {z.findings.map((f) => (
              <li key={f.key} className="text-[13px]">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={TONE[f.tone]}>{f.tone === 'info' ? 'note' : f.tone === 'ok' ? 'good' : f.tone === 'bad' ? 'act now' : 'review'}</Badge><span className="font-medium text-ink">{f.title}</span></div>
                <p className="mt-0.5 text-[12.5px] break-words text-ink-2">{f.detail}</p>
                {f.fix && <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] break-words text-muted">{f.fix.map((x) => <li key={x}>{x}</li>)}</ul>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {t && (
        <div className="grid grid-cols-2 gap-3 border-b border-line px-5 py-4 md:grid-cols-5">
          <Stat label="Requests" value={exact(total)} sub="in the window" />
          <Stat label="Checked" value={exact(checked)} sub={`${share(checked, total)} carried credentials`} />
          <Stat label="Leaked" value={exact(t.leaked)} tone={t.leaked ? 'bad' : 'ok'} sub={`${share(t.leaked, checked)} of checked`} />
          <Stat label="Stopped" value={stopped === null ? '—' : exact(stopped)} sub={stopped === null ? 'action not in analytics' : `${share(stopped, t.leaked)} blocked or challenged`} />
          <Stat label="Answered 2xx/3xx" value={exact(okCount)} tone={okCount ? 'bad' : undefined} sub={`${share(okCount, t.leaked)} of leaked`} />
        </div>
      )}

      <div className="grid gap-5 border-b border-line px-5 py-4 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Configuration</h3>
          <dl className="grid grid-cols-[11rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-muted">Detection</dt>
            <dd className="text-ink-2">{c?.enabled === null || !c ? (c?.enabledNote ?? 'Not read') : c.enabled ? 'On' : 'Off'}</dd>
            <dt className="text-muted">Exposed-Credential-Check header</dt>
            <dd className="text-ink-2">{c?.header === null || !c ? 'Not read' : c.header ? 'Added to origin requests (managed transform on)' : 'Not added (managed transform off)'}</dd>
            <dt className="text-muted">Custom detection locations</dt>
            <dd className="break-words text-ink-2">{c?.detections ? (c.detections.length ? exact(c.detections.length) : 'None: default locations only') : (c?.detectionsNote ?? 'Not read')}</dd>
          </dl>
          {c?.detections && c.detections.length > 0 && (
            <div className="mt-3 space-y-2">
              {c.detections.map((d) => (
                <div key={d.id} className="text-[12px]">
                  <div className="font-mono text-faint break-all">{d.id}</div>
                  <Code>{`username: ${d.username || '(none)'}\npassword: ${d.password || '(none)'}`}</Code>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Rules using credential fields</h3>
          {c?.rulesNote && <p className="mb-2 text-[12px] break-words text-warn">{c.rulesNote}</p>}
          {c?.rules.length ? (
            <ul className="space-y-3">
              {c.rules.map((r) => (
                <li key={`${r.phase}:${r.id}`} className="text-[12.5px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{r.phase === 'custom' ? 'custom rule' : 'rate limiting'}</Badge>
                    <Badge tone={!r.enabled ? 'neutral' : r.action === 'log' ? 'warn' : 'ok'}>{r.enabled ? actionLabel(r.action) : 'off'}</Badge>
                    {r.rate && <Badge>{exact(r.rate.requests)} per {r.rate.period >= 60 && r.rate.period % 60 === 0 ? `${r.rate.period / 60} min` : `${r.rate.period} s`}</Badge>}
                    <span className="font-medium break-words text-ink">{r.description || r.id}</span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-muted">{r.fields.map((f) => `${CREDENTIAL_FIELDS[f]?.label ?? f} (${CREDENTIAL_FIELDS[f]?.plan ?? 'see docs'})`).join(' · ')}</p>
                  <Code className="mt-1">{r.expression}</Code>
                </li>
              ))}
            </ul>
          ) : <p className="text-[12.5px] text-muted">{c ? 'No custom or rate limiting rule uses a cf.waf.credential_check.* field.' : 'Not read.'}</p>}
        </div>
      </div>

      {t && (
        <div className="space-y-5 px-5 py-4">
          <Counts title="Every request by check result" sub={`Analytics field ${t.field}`} head={['Result', 'Value']} of={total}
            rows={t.results.map((r) => ({ key: r.result, count: r.count, cells: [<Result key="r" v={r.result} />, <span key="v" className="font-mono text-faint">{r.result || '(empty)'}</span>] }))} />
          {t.leaked > 0 && (
            <div className="grid gap-5 lg:grid-cols-2">
              <Counts title="Leaked requests by response status" sub="2xx/3xx after a login may mean it worked" head={['Result', 'Status']} of={t.leaked}
                rows={t.byStatus.map((r) => ({ key: `${r.result}:${r.status}`, count: r.count, cells: [<Result key="r" v={r.result} />, <span key="s" className={cx('font-mono', answeredOk(r.status) && 'font-semibold text-bad')}>{r.status || '—'}</span>] }))} />
              {t.byAction ? (
                <Counts title="Leaked requests by security action" head={['Result', 'Action']} of={t.leaked}
                  rows={t.byAction.map((r) => ({ key: `${r.result}:${r.action}`, count: r.count, cells: [<Result key="r" v={r.result} />, <Badge key="a" tone={stops(r.action) ? 'ok' : 'warn'}>{r.action === 'none' ? 'none (let through)' : actionLabel(r.action)}</Badge>] }))} />
              ) : <p className="text-[12px] text-muted">This plan&apos;s request analytics do not offer the security action, so stopped and let-through requests cannot be told apart here.</p>}
              <Counts title="Paths" sub={t.paths.length >= 100 ? 'The busiest 100' : undefined} head={['Result', 'Method', 'Path']} of={t.leaked}
                rows={t.paths.map((r) => ({ key: `${r.result}:${r.method}:${r.host}${r.path}`, count: r.count, cells: [<Result key="r" v={r.result} />, <span key="m" className="font-mono">{r.method}</span>, <span key="p" className="font-mono">{r.host}{r.path}</span>] }))} />
              <Counts title="Clients" sub={t.ips.length >= 100 ? 'The busiest 100' : undefined} head={['IP', 'Network', 'Country']} of={t.leaked}
                rows={t.ips.map((r) => ({ key: r.ip, count: r.count, cells: [<span key="i" className="font-mono">{r.ip}</span>, <span key="a">AS{r.asn} {r.asnName}</span>, r.country] }))} />
            </div>
          )}
          {t.hours.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[12px] font-semibold tracking-wide text-muted uppercase select-none">Leaked requests by hour ({((n) => `${exact(n)} hour${n === 1 ? '' : 's'}`)(new Set(t.hours.map((h) => h.hour)).size)})</summary>
              <div className="mt-2">
                <Counts title="" head={['Hour', 'Result']} of={t.leaked}
                  rows={t.hours.map((h) => ({ key: `${h.hour}:${h.result}`, count: h.count, cells: [<span key="h" className="font-mono whitespace-nowrap">{fmtDate(h.hour)}</span>, <Result key="r" v={h.result} />] }))} />
              </div>
            </details>
          )}
          {t.note && <p className="text-[12px] text-warn">{t.note}</p>}
        </div>
      )}
    </Card>
  );
}

export default function LeakedPage() {
  const accounts = useAccounts();
  const [scope, setScope] = useState<'zone' | 'account'>('zone');
  const [zone, setZone] = useState<PickedZone | null>(null);
  const [account, setAccount] = useState('');
  const [hours, setHours] = useState<number>(24);
  const [offset, setOffset] = useState(0);
  const [path, setPath] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const job = useJob<LeakedReport>(path);

  const go = (o: number) => {
    const p = new URLSearchParams({ hours: String(hours) });
    if (scope === 'zone') { if (!zone) return setFormError('Choose the zone'); p.set('zone', zone.id); }
    else { if (!account) return setFormError('Choose the account'); p.set('account', account); p.set('offset', String(o)); p.set('limit', String(PAGE)); }
    setFormError(''); setOffset(o); setPath(`/api/investigate/leaked?${p}`);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go(0); };
  const r = job.data;

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Investigate" title="Leaked credentials"
        description="Cloudflare's leaked credentials detection checks logins against credentials known from breaches. For each zone: whether detection is on, where it looks, which rules act on it, and the requests that carried leaked credentials — how many, whether security stopped them, what the site answered, on which paths and from which clients. Nothing is changed in Cloudflare."
        actions={r ? <RefreshBar at={job.at} busy={job.busy} onRefresh={job.reload} generatedAt={r.generatedAt} /> : undefined} />
      <Card className="px-5 py-5">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium text-ink-2">Look at</legend>
            <div className="flex flex-wrap gap-2">
              {(['zone', 'account'] as const).map((v) => (
                <label key={v} className={cx('cursor-pointer rounded-lg border px-3 py-2 text-sm', scope === v ? 'border-signal/60 bg-signal/[0.07]' : 'border-line bg-sunken/60')}>
                  <input type="radio" name="scope" className="mr-2" checked={scope === v} onChange={() => setScope(v)} />{v === 'zone' ? 'One zone' : `An account (${PAGE} zones a page, busiest first)`}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
            {scope === 'zone' ? <ZonePicker label="Zone" value={zone} onChange={setZone} /> : (
              <Field label="Account">
                <select className="input" value={account} onChange={(e) => setAccount(e.target.value)}>
                  <option value="">{accounts ? 'Choose an account' : 'Loading accounts…'}</option>
                  {(accounts ?? []).map((a) => <option key={a.id} value={a.id}>{a.name} ({whole.format(a.zones)} zones)</option>)}
                </select>
              </Field>
            )}
            <Field label="Window">
              <select className="input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {LEAKED_WINDOWS.map((h) => <option key={h} value={h}>{h === 24 ? 'Last 24 hours' : `Last ${h / 24} days`}</option>)}
              </select>
            </Field>
          </div>
          {formError && <p className="text-[13px] text-bad" role="alert">{formError}</p>}
          <Button type="submit" variant="primary" icon={<KeyRound className="size-4" />} loading={job.busy}>Check</Button>
        </form>
      </Card>
      {job.error && <Alert tone="bad" title="Could not read leaked credentials">{job.error}</Alert>}
      {job.busy && !r && <Reading what="leaked credentials" pending={job.pending} />}
      {r && (
        <>
          {r.scope.kind === 'account' && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13px] text-muted">Zones {r.offset + 1}–{Math.min(r.offset + r.limit, r.totalZones)} of {whole.format(r.totalZones)} in {r.scope.name}</p>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} disabled={offset === 0 || job.busy} onClick={() => go(Math.max(0, offset - PAGE))}>Previous</Button>
                <Button size="sm" variant="ghost" disabled={offset + PAGE >= r.totalZones || job.busy} onClick={() => go(offset + PAGE)}>Next <ChevronRight className="size-4" /></Button>
              </div>
            </div>
          )}
          {r.zones.map((z) => <Zone key={z.zoneId} z={z} />)}
          <Card>
            <SectionHeader title="Rule fields" description="What Cloudflare offers to act on leaked credentials, and the plan each needs (developers.cloudflare.com/waf/detections/leaked-credentials)." />
            <ul className="divide-y divide-line/60 text-[12.5px]">
              {Object.entries(CREDENTIAL_FIELDS).map(([f, d]) => (
                <li key={f} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2"><span className="font-mono break-all text-ink-2">{f}</span><span className="text-muted">{d.label} · {d.plan}</span></li>
              ))}
            </ul>
          </Card>
        </>
      )}
      {!path && <Card><EmptyState icon={<KeyRound className="size-5" />} title="Choose a zone or an account" description="Its leaked-credential settings and rules are read from the API (5 reads per zone) and its requests from Cloudflare's analytics (about 2–3 queries per 3 days), then kept for 30 minutes." /></Card>}
    </div>
  );
}
