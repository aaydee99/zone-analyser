'use client';

import { useState, type FormEvent } from 'react';
import { Plus, Route, Trash2 } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import type { TraceResult, TraceStep } from '@/lib/investigate-types';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, PageHeader, SectionHeader, cx } from '@/components/ui';
import { Code } from '../shared';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const PROTOCOLS = ['HTTP/1.1', 'HTTP/2', 'HTTP/3', 'HTTP/1.0'];
interface Pair { name: string; value: string }

/** Name / value rows (headers, cookies), each with its own labelled inputs. */
function Pairs({ title, rows, onChange }: { title: string; rows: Pair[]; onChange: (r: Pair[]) => void }) {
  const set = (i: number, p: Partial<Pair>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-[13px] font-medium text-ink-2">{title} <span className="text-[11px] font-normal text-faint">optional</span></legend>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] gap-2">
          <input className="input font-mono" aria-label={`${title}: name ${i + 1}`} placeholder="Name" value={r.name} onChange={(e) => set(i, { name: e.target.value })} spellCheck={false} />
          <input className="input font-mono" aria-label={`${title}: value ${i + 1}`} placeholder="Value" value={r.value} onChange={(e) => set(i, { value: e.target.value })} spellCheck={false} />
          <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${title.toLowerCase()} ${i + 1}`} icon={<Trash2 className="size-3.5" />} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { name: '', value: '' }])}>Add</Button>
    </fieldset>
  );
}

const matchedInside = (s: TraceStep): boolean => !!s.matched || (s.trace ?? []).some(matchedInside);

/** One step and what it contains. Steps that did not match are shown only on request. */
function Step({ s, all }: { s: TraceStep; all: boolean }) {
  const kids = (s.trace ?? []).filter((x) => all || matchedInside(x));
  const title = s.name || s.description || s.step_name || s.type || 'step';
  return (
    <li className="relative pl-5">
      <span className={cx('absolute top-2 left-0 size-2.5 rounded-full border-2', s.matched ? 'border-signal bg-signal' : 'border-line-strong bg-surface')} aria-hidden />
      <div className={cx('rounded-lg px-3 py-2', s.matched ? 'bg-signal/[0.06]' : '')}>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className={cx('font-medium', s.matched ? 'text-ink' : 'text-ink-2')}>{title}</span>
          {s.type && <Badge>{s.type}</Badge>}
          {s.kind && <Badge tone="info">{s.kind}</Badge>}
          {s.action && <Badge tone={/block|challenge/.test(s.action) ? 'warn' : 'neutral'}>{s.action}</Badge>}
          {s.matched !== undefined && <span className={cx('text-[11px]', s.matched ? 'text-signal' : 'text-faint')}>{s.matched ? 'matched' : 'did not match'}</span>}
        </div>
        {s.step_name && s.step_name !== title && <div className="mt-0.5 font-mono text-[11px] text-faint">{s.step_name}</div>}
        {s.expression && <Code className="mt-1.5">{s.expression}</Code>}
        {s.action_parameters !== undefined && s.matched && <details className="mt-1.5 text-[12px]"><summary className="cursor-pointer text-muted">Action parameters</summary><Code className="mt-1">{JSON.stringify(s.action_parameters, null, 2)}</Code></details>}
      </div>
      {kids.length > 0 && <ol className="mt-1 ml-1 space-y-1 border-l border-line pl-3">{kids.map((k, i) => <Step key={i} s={k} all={all} />)}</ol>}
    </li>
  );
}

export default function TracePage() {
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [protocol, setProtocol] = useState('HTTP/1.1');
  const [headers, setHeaders] = useState<Pair[]>([{ name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }]);
  const [cookies, setCookies] = useState<Pair[]>([]);
  const [body, setBody] = useState('');
  const [botScore, setBotScore] = useState('');
  const [threatScore, setThreatScore] = useState('');
  const [country, setCountry] = useState('');
  const [skipChallenge, setSkipChallenge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [r, setR] = useState<TraceResult | null>(null);
  const [all, setAll] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      setR(await api<TraceResult>('/api/investigate/trace', { method: 'POST', json: {
        url: url.trim(), method, protocol, headers: headers.filter((h) => h.name.trim()), cookies: cookies.filter((c) => c.name.trim()),
        ...(body && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
        ...(botScore ? { botScore: Number(botScore) } : {}), ...(threatScore ? { threatScore: Number(threatScore) } : {}),
        ...(country ? { country } : {}), skipChallenge,
      } }));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };

  const matched = r ? r.trace.filter(matchedInside).length : 0;
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Investigate" title="URL trace"
        description="Run a made-up request through the zone's rules with Cloudflare's request tracer and see which rules match, phase by phase. Nothing is changed and the request is never sent to the origin. The stored token needs “Account › Request Tracer › Read”." />
      <Card className="px-5 py-5">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="grid gap-4 md:grid-cols-[8rem_minmax(0,1fr)_9rem]">
            <Field label="Method"><select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>{METHODS.map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="URL"><input className="input font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.example.com/login?next=/" spellCheck={false} required /></Field>
            <Field label="Protocol"><select className="input" value={protocol} onChange={(e) => setProtocol(e.target.value)}>{PROTOCOLS.map((p) => <option key={p}>{p}</option>)}</select></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Bot score" optional hint="1 (bot) – 99 (human)"><input className="input" type="number" min={1} max={99} value={botScore} onChange={(e) => setBotScore(e.target.value)} /></Field>
            <Field label="Threat score" optional hint="0 – 100"><input className="input" type="number" min={0} max={100} value={threatScore} onChange={(e) => setThreatScore(e.target.value)} /></Field>
            <Field label="Country" optional hint="Two letters, e.g. DE"><input className="input uppercase" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value)} /></Field>
          </div>
          <Checkbox checked={skipChallenge} onChange={setSkipChallenge} label="Treat challenges as passed (skip challenge)" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Pairs title="Headers" rows={headers} onChange={setHeaders} />
            <Pairs title="Cookies" rows={cookies} onChange={setCookies} />
          </div>
          {method !== 'GET' && method !== 'HEAD' && <Field label="Body" optional><textarea className="input min-h-24 font-mono" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} /></Field>}
          <p className="text-xs text-muted">Headers and cookies go to Cloudflare for this trace only; the console does not keep or log them.</p>
          <Button type="submit" variant="primary" icon={<Route className="size-4" />} loading={busy}>Trace</Button>
        </form>
      </Card>
      {error && <Alert tone="bad" title="The trace failed">{error}</Alert>}
      {r && (
        <Card>
          <SectionHeader title={`${r.method} ${r.url}`} description={`${r.zoneName} · ${r.accountName} · traced ${fmtDate(r.generatedAt)}${r.statusCode !== null ? ` · the zone would answer ${r.statusCode}` : ''}`}
            aside={<Checkbox checked={all} onChange={setAll} label="Show steps that did not match" />} />
          <div className="px-5 py-4">
            {!r.trace.length ? <p className="text-sm text-muted">Cloudflare returned no steps.</p> : !all && !matched ? <p className="text-sm text-muted">No rule matched this request. Show the steps that did not match to see what was evaluated.</p> : (
              <ol className="space-y-2">{r.trace.filter((s) => all || matchedInside(s)).map((s, i) => <Step key={i} s={s} all={all} />)}</ol>
            )}
          </div>
        </Card>
      )}
      {!r && !error && <Card><EmptyState icon={<Route className="size-5" />} title="Trace a URL" description="The URL's host picks the zone. Set headers, cookies, a country or a bot score to see how the rules treat that request." /></Card>}
    </div>
  );
}
