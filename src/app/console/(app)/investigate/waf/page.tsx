'use client';

import { useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, Copy, ShieldQuestion } from 'lucide-react';
import { copyText } from '@/lib/client';
import { WAF_WINDOWS, type WafReport, type WafSuspect } from '@/lib/investigate-types';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, SectionHeader, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { Code, RefreshBar, Reading, ZonePicker, useAccounts, useJob, whole, type PickedZone } from '../shared';

const PAGE = 5;
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const tone = (score: number) => (score >= 60 ? 'bad' : score >= 35 ? 'warn' : 'neutral');

function Suspect({ s }: { s: WafSuspect }) {
  const toast = useToast();
  const d = s.draft;
  const json = JSON.stringify({ description: `Exception: ${s.description || s.ruleId} on ${s.path}`, expression: d.expression, action: d.action, action_parameters: d.actionParameters }, null, 2);
  const copy = async (text: string) => { await copyText(text); toast('Copied'); };
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={tone(s.score)}>score {s.score}</Badge>
            <Badge>{s.source}</Badge>
            <span className="text-[14px] font-semibold break-words">{s.description || s.ruleId || 'Unnamed rule'}</span>
          </div>
          <p className="mt-1 text-[12.5px] text-muted">
            {s.zoneName} · <span className="font-mono">{s.host}{s.path}</span> ({pct(s.pathShare)} of its mitigations)
            {s.rulesetName ? ` · ${s.rulesetName}` : ''}{s.ruleId ? <> · rule <span className="font-mono">{s.ruleId}</span></> : null}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-x-5 gap-y-1 text-right text-[12px] sm:grid-cols-6">
          {([['Mitigated', whole.format(s.mitigated)], ['Blocked', whole.format(s.blocked)], ['Challenged', whole.format(s.challenged)], ['Solved', whole.format(s.solved)], ['IPs', whole.format(s.ips)], ['Path OK', pct(s.okShare)]] as const).map(([k, v]) => (
            <div key={k}><div className="text-faint">{k}</div><div className="font-mono tabular-nums text-ink">{v}</div></div>
          ))}
        </div>
      </div>
      <div className="grid gap-5 px-5 py-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Why it ranks here</h3>
          <ul className="space-y-1 text-[13px]">
            {s.signals.map((g) => (
              <li key={g.key} className="flex gap-2">
                <span className={cx('w-10 shrink-0 text-right font-mono tabular-nums', g.points > 0 ? 'text-warn' : 'text-ok')}>{g.points > 0 ? `+${g.points}` : g.points}</span>
                <span><span className="font-medium text-ink-2">{g.label}</span> <span className="text-muted">— {g.detail}</span></span>
              </li>
            ))}
            {!s.signals.length && <li className="text-muted">No signal points either way.</li>}
          </ul>
          <p className="mt-2 text-[12px] text-faint">{pct(s.residentialShare)} consumer networks · {pct(s.browserShare)} browser user agents · {whole.format(s.asns)} networks</p>
        </div>
        <div>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">Draft exception (not applied)</h3>
          <p className="text-[13px] text-ink-2">{d.where}</p>
          <Code className="mt-2">{d.expression}</Code>
          {d.action === 'skip' && <Code className="mt-2">{json}</Code>}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => copy(d.expression)}>Copy expression</Button>
            {d.action === 'skip' && <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => copy(json)}>Copy as rule JSON</Button>}
          </div>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-muted">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      </div>
    </Card>
  );
}

export default function WafPage() {
  const accounts = useAccounts();
  const [scope, setScope] = useState<'zone' | 'account'>('zone');
  const [zone, setZone] = useState<PickedZone | null>(null);
  const [account, setAccount] = useState('');
  const [hours, setHours] = useState<number>(24);
  const [offset, setOffset] = useState(0);
  const [path, setPath] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [minScore, setMinScore] = useState(30);
  const job = useJob<WafReport>(path);

  const go = (o: number) => {
    const p = new URLSearchParams({ hours: String(hours) });
    if (scope === 'zone') { if (!zone) return setFormError('Choose the zone'); p.set('zone', zone.id); }
    else { if (!account) return setFormError('Choose the account'); p.set('account', account); p.set('offset', String(o)); p.set('limit', String(PAGE)); }
    setFormError(''); setOffset(o); setPath(`/api/investigate/waf?${p}`);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go(0); };
  const r = job.data;
  const shown = (r?.suspects ?? []).filter((s) => s.score >= minScore);

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Investigate" title="WAF false positives"
        description="Rules that block or challenge traffic that looks legitimate — many different clients on ordinary browsers from consumer networks, on paths that otherwise work, with challenges people solve. Ranked by an explainable score, each with a draft exception you can copy into the dashboard. Nothing is changed in Cloudflare."
        actions={r ? <RefreshBar at={job.at} busy={job.busy} onRefresh={job.reload} generatedAt={r.generatedAt} /> : undefined} />
      <Alert tone="info" title="A heuristic">The score says what to look at first. It does not prove a rule is wrong: read the events in Traffic analytics before you add an exception, and keep every exception as narrow as you can.</Alert>
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
                {WAF_WINDOWS.map((h) => <option key={h} value={h}>{h === 24 ? 'Last 24 hours' : `Last ${h / 24} days`}</option>)}
              </select>
            </Field>
          </div>
          {formError && <p className="text-[13px] text-bad" role="alert">{formError}</p>}
          <Button type="submit" variant="primary" icon={<ShieldQuestion className="size-4" />} loading={job.busy}>Find suspects</Button>
        </form>
      </Card>
      {job.error && <Alert tone="bad" title="Could not read the security events">{job.error}</Alert>}
      {job.busy && !r && <Reading what="security events" pending={job.pending} />}
      {r && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-muted">
              {r.scope.kind === 'account' ? <>Zones {r.offset + 1}–{Math.min(r.offset + r.limit, r.totalZones)} of {whole.format(r.totalZones)} in {r.scope.name}</> : r.scope.name} · {shown.length} of {r.suspects.length} rules at score {minScore} or more
            </p>
            <div className="flex items-center gap-2">
              <label className="text-[12px] text-muted" htmlFor="waf-min">Minimum score</label>
              <select id="waf-min" className="input !w-auto" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}>{[0, 30, 50, 70].map((n) => <option key={n} value={n}>{n}</option>)}</select>
              {r.scope.kind === 'account' && (
                <>
                  <Button size="sm" variant="ghost" icon={<ChevronLeft className="size-4" />} disabled={offset === 0 || job.busy} onClick={() => go(Math.max(0, offset - PAGE))}>Previous</Button>
                  <Button size="sm" variant="ghost" disabled={offset + PAGE >= r.totalZones || job.busy} onClick={() => go(offset + PAGE)}>Next <ChevronRight className="size-4" /></Button>
                </>
              )}
            </div>
          </div>
          {shown.map((s) => <Suspect key={`${s.zoneId}:${s.ruleId}:${s.source}`} s={s} />)}
          {!shown.length && <Card><EmptyState icon={<ShieldQuestion className="size-5" />} title="No suspect at this score" description="No rule here blocks or challenges traffic in a way that looks legitimate. Lower the minimum score to see every rule that acted." /></Card>}
          <Card>
            <SectionHeader title="Zones read" />
            <ul className="divide-y divide-line/60 text-[13px]">
              {r.zones.map((z) => (
                <li key={z.zoneId} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2">
                  <span className="font-medium">{z.zoneName}</span>
                  <span className="text-muted">
                    <Badge tone={z.status === 'ok' ? 'ok' : z.status === 'no events' ? 'neutral' : 'warn'}>{z.status}</Badge>
                    {z.status === 'ok' && <span className="ml-2">{whole.format(z.events)} events · {z.suspects.length} rules</span>}
                    {z.message && <span className="ml-2">{z.message}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
      {!path && <Card><EmptyState icon={<ShieldQuestion className="size-5" />} title="Choose a zone or an account" description="Its security events of the window are read from Cloudflare's analytics (about 3–8 queries per zone) and kept for 30 minutes." /></Card>}
    </div>
  );
}
