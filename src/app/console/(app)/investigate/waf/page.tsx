'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Copy, ShieldQuestion } from 'lucide-react';
import { copyText, fmtDate } from '@/lib/client';
import { WAF_WINDOWS, type WafReport, type WafSuspect } from '@/lib/investigate-types';
import { actionLabel, sourceLabel, tuningLines } from '@/lib/waf-labels';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, SectionHeader, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { Code, RefreshBar, Reading, ZonePicker, useAccounts, useJob, whole, type PickedZone } from '../shared';

const PAGE = 5;
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const tone = (score: number) => (score >= 60 ? 'bad' : score >= 35 ? 'warn' : 'neutral');

/** Exact counts in the evidence (not rounded to 9.7k). */
const exact = (n: number) => n.toLocaleString('en-US');
const share = (n: number, of: number) => (of ? `${(Math.round((n / of) * 1000) / 10).toFixed(1)}%` : '—');
const pts = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/** One breakdown: the busiest rows with their counts and share of the events counted. */
function Breakdown({ title, total, of, rows }: { title: string; total: number; of: number; rows: { key: string; cells: ReactNode[]; count: number }[] }) {
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-[12px] font-semibold text-ink-2">{title}</h4>
      <p className="mb-1.5 text-[11.5px] text-faint">{rows.length < total ? `The busiest ${rows.length} of ${exact(total)}` : `All ${exact(total)}`} · {exact(of)} events counted</p>
      {rows.length ? (
        <table className="w-full text-[12px]">
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
      ) : <p className="text-[12px] text-muted">None read.</p>}
    </div>
  );
}

/** How the score was reached: every check with the numbers it measured, and the counts read from Cloudflare. */
function Evidence({ s }: { s: WafSuspect }) {
  const e = s.evidence;
  if (!e) return <p className="px-5 py-4 text-[12.5px] text-muted">This result was kept from before evidence was recorded. Refresh to read it again.</p>;
  const scored = e.checks.filter((c) => c.points);
  const other = s.mitigated - s.blocked - s.challenged;
  return (
    <details open className="group border-t border-line">
      <summary className="cursor-pointer px-5 py-3 text-[12px] font-semibold tracking-wide text-muted uppercase select-none">Evidence: how the score was reached</summary>
      <div className="space-y-5 px-5 pb-5">
        <p className="text-[12.5px] text-ink-2">
          Read from Cloudflare security events {fmtDate(e.since)} – {fmtDate(e.until)} (log-only, allow and skip events left out).
          Mitigated {exact(s.mitigated)} = blocked {exact(s.blocked)} + challenged {exact(s.challenged)}{other ? ` + other actions ${exact(other)}` : ''}; {exact(s.solved)} challenges solved.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-[12.5px]">
            <thead>
              <tr className="text-left text-[11.5px] text-faint">
                <th className="py-1 pr-3 font-medium">Check</th><th className="py-1 pr-3 font-medium">Measured</th><th className="py-1 pr-3 font-medium">Scoring bands</th><th className="py-1 text-right font-medium">Points</th>
              </tr>
            </thead>
            <tbody>
              {e.checks.map((c) => (
                <tr key={c.key} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3 font-medium text-ink-2">{c.label}</td>
                  <td className="py-1.5 pr-3 font-mono text-[12px] break-words text-ink">{c.measured}</td>
                  <td className="py-1.5 pr-3 text-[12px] break-words text-muted">{c.bands}</td>
                  <td className={cx('py-1.5 text-right font-mono tabular-nums', c.points > 0 ? 'text-warn' : c.points < 0 ? 'text-ok' : 'text-faint')}>{pts(c.points)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line">
                <td colSpan={3} className="py-1.5 pr-3 font-mono text-[12px] break-words text-ink-2">
                  {scored.length ? scored.map((c) => pts(c.points)).join(' ') : '0'} = {pts(e.sum)}{e.sum !== s.score ? ` → kept within 0–100 = ${s.score}` : ''}
                </td>
                <td className="py-1.5 text-right font-mono font-semibold tabular-nums text-ink">{s.score}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {e.pathStatus && (
          <p className="text-[12.5px] text-ink-2">
            Main path <span className="font-mono break-all">{s.host}{s.path}</span>: {exact(e.pathStatus.requests)} requests in the window, {exact(e.pathStatus.stopped)} stopped by security,
            {' '}{exact(e.pathStatus.others)} answered by the site, of which {exact(e.pathStatus.ok)} ({share(e.pathStatus.ok, e.pathStatus.others)}) were 2xx/3xx.
          </p>
        )}
        <div className="grid gap-5 lg:grid-cols-2">
          <Breakdown title="Client IP addresses" total={e.ipCount} of={e.counted.ips}
            rows={e.topIps.map((x) => ({ key: x.ip, count: x.count, cells: [<span key="i" className="font-mono">{x.ip}</span>] }))} />
          <Breakdown title={`Networks · consumer ${exact(e.consumerEvents)} (${share(e.consumerEvents, e.counted.asns)}) · hosting ${exact(e.hostingEvents)} (${share(e.hostingEvents, e.counted.asns)})`} total={e.networkCount} of={e.counted.asns}
            rows={e.networks.map((x) => ({ key: x.asn, count: x.count, cells: [<span key="a" className="font-mono">AS{x.asn}</span>, x.name || '—', <Badge key="k" tone={x.consumer ? 'neutral' : 'warn'}>{x.consumer ? 'consumer' : 'hosting'}</Badge>] }))} />
          <Breakdown title={`User agents · browser ${exact(e.browserEvents)} (${share(e.browserEvents, e.counted.uas)})`} total={e.uaCount} of={e.counted.uas}
            rows={e.userAgents.map((x) => ({ key: x.ua, count: x.count, cells: [<span key="u" className="font-mono text-[11.5px]">{x.ua || '(empty)'}</span>, <Badge key="b" tone={x.browser ? 'neutral' : 'warn'}>{x.browser ? 'browser' : 'not a browser'}</Badge>] }))} />
          <Breakdown title="Paths" total={e.pathCount} of={e.counted.paths}
            rows={e.paths.map((x) => ({ key: `${x.host}${x.path}`, count: x.count, cells: [<span key="p" className="font-mono">{x.host}{x.path}</span>] }))} />
        </div>
        <p className="text-[11.5px] text-faint">Cloudflare counts each breakdown separately, so their totals can differ a little from each other and from the mitigated count. Consumer means any network not on the hosting / cloud list; browser means a Mozilla/5.0 user agent of Chrome, Firefox, Safari, Edge or Opera with no bot or tool name.</p>
      </div>
    </details>
  );
}

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
            {s.rulesetName ? ` · ${s.rulesetName}` : ''}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-x-5 gap-y-1 text-right text-[12px] sm:grid-cols-6">
          {([['Mitigated', exact(s.mitigated)], ['Blocked', exact(s.blocked)], ['Challenged', exact(s.challenged)], ['Solved', exact(s.solved)], ['IPs', exact(s.ips)], ['Path OK', pct(s.okShare)]] as const).map(([k, v]) => (
            <div key={k}><div className="text-faint">{k}</div><div className="font-mono tabular-nums text-ink">{v}</div></div>
          ))}
        </div>
      </div>
      <div className="grid gap-5 border-b border-line px-5 py-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">The rule</h3>
          <dl className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
            {([
              ['Rule', s.description || 'Unnamed rule'],
              ['Rule ID', s.ruleId ? <span className="font-mono text-[12px] break-all">{s.ruleId}</span> : '—'],
              ['Ruleset', s.rulesetName ?? (s.rulesetId ? <span className="font-mono text-[12px] break-all">{s.rulesetId}</span> : '—')],
              ['Kind', sourceLabel(s.source)],
              ['Current action', <span key="a"><span className="font-medium text-ink">{actionLabel(s.currentAction)}</span>
                <span className="block text-[12px] text-muted">on these requests: {(s.actions ?? []).map((a) => `${actionLabel(a.action)} ${exact(a.count)}`).join(' · ')}</span></span>],
              ...(s.deploy ? tuningLines(s.deploy).map(([k, v]) => [k, v] as [string, ReactNode]) : []),
              ...(s.deploy?.ruleOverride ? [['This rule’s override', s.deploy.ruleOverride] as [string, ReactNode]] : []),
              ['Mostly on', <span key="p" className="font-mono text-[12px] break-all">{s.host}{s.path}</span>],
            ] as [string, ReactNode][]).map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words text-ink-2">{v}</dd></div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">How to fix it</h3>
          <p className="mb-2 text-[12px] text-muted">First check the matches are legitimate: Security › Events, filtered by rule ID {s.ruleId || '(this rule)'}{s.path ? ` and path ${s.path}` : ''}.</p>
          <ol className="space-y-3 text-[13px]">
            {(s.fixes ?? []).map((f, i) => (
              <li key={f.title} className="flex gap-2">
                <span className="w-5 shrink-0 text-right font-mono text-faint tabular-nums">{i + 1}.</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{f.title}</span>{f.best && <Badge tone="ok">narrowest — try first</Badge>}</div>
                  <p className="text-[12px] text-muted">{f.why}</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12px] break-words text-ink-2">{f.steps.map((t) => <li key={t}>{t}</li>)}</ul>
                </div>
              </li>
            ))}
          </ol>
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
          <p className="mt-2 text-[12px] text-faint">{pct(s.residentialShare)} consumer networks · {pct(s.browserShare)} browser user agents · {exact(s.asns)} networks</p>
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
      <Evidence s={s} />
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
