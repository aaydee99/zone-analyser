'use client';

import { useEffect, useId, useState } from 'react';
import { FileUp, GitCompare, RefreshCw, Search, Radar } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import type { DiffKind } from '@/lib/bind-zone';
import type { CompareView, PendingRow, PendingView, WatchView } from '@/lib/onboarding-types';
import type { HealthView } from '@/lib/zone-health-types';
import { Alert, Badge, Button, Card, EmptyState, Loading, PageHeader, SectionHeader, SkeletonTable, cx } from '@/components/ui';
import { when } from '@/components/monitor-view';
import { useToast } from '@/components/toast';
import { useSnapshot } from '../monitoring/use-run';

const whole = new Intl.NumberFormat();
const MAX_BYTES = 512 * 1024;
const KINDS: { kind: DiffKind; label: string; tone: 'bad' | 'warn' | 'info' | 'neutral' }[] = [
  { kind: 'missing', label: 'Missing on Cloudflare', tone: 'bad' }, { kind: 'breaks', label: 'Will break', tone: 'bad' }, { kind: 'different', label: 'Different', tone: 'warn' },
  { kind: 'proxied', label: 'Proxy differs', tone: 'warn' }, { kind: 'ttl', label: 'TTL differs', tone: 'info' }, { kind: 'extra', label: 'Only on Cloudflare', tone: 'info' }, { kind: 'note', label: 'Notes', tone: 'neutral' },
];

function useSettled<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Picks a zone monitoring knows, by the start of its name (from the stored health table). */
function ZonePicker({ value, onPick }: { value: { id: string; name: string } | null; onPick: (z: { id: string; name: string }) => void }) {
  const id = useId();
  const [q, setQ] = useState('');
  const term = useSettled(q.trim());
  const [found, setFound] = useState<{ term: string; list: { id: string; name: string; account: string }[] }>({ term: '', list: [] });
  useEffect(() => {
    let live = true;
    if (!term) return;
    api<HealthView>(`/api/zone-health?q=${encodeURIComponent(term)}&sort=name&limit=8`)
      .then((p) => { if (live) setFound({ term, list: p.rows.map((r) => ({ id: r.zoneId, name: r.zoneName, account: r.accountName ?? '' })) }); })
      .catch(() => { if (live) setFound({ term, list: [] }); });
    return () => { live = false; };
  }, [term]);
  const hits = term && found.term === term && q.trim() ? found.list : [];
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-[12px] text-muted">Zone</label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
        <input id={id} className="input !w-72 !py-1.5 !pl-8 !text-[13px]" placeholder={value ? value.name : 'Start of the zone name, or its ID'} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </div>
      {value && <span className="text-[12px] text-ink-2">Chosen: <span className="font-mono">{value.name}</span></span>}
      {hits.length > 0 && (
        <ul className="mt-1 w-72 rounded-lg border border-line bg-surface text-[13px]" aria-label="Matching zones">
          {hits.map((h) => (
            <li key={h.id}><button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-raised" onClick={() => { onPick({ id: h.id, name: h.name }); setQ(''); }}>
              <span className="font-mono">{h.name}</span> <span className="text-faint">{h.account}</span>
            </button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Compare() {
  const toast = useToast();
  const fileId = useId();
  const textId = useId();
  const [zone, setZone] = useState<{ id: string; name: string } | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CompareView | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<DiffKind | 'all'>('all');
  const [shown, setShown] = useState(200);
  const load = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_BYTES) { toast(`The file is larger than ${MAX_BYTES / 1024} KB`, 'bad'); return; }
    setText(await f.text());
  };
  const run = async (fresh = false) => {
    if (!zone) { setError('Choose the zone to compare with first.'); return; }
    setBusy(true);
    try { setResult(await api<CompareView>('/api/onboarding/compare', { method: 'POST', json: { zoneId: zone.id, text, fresh } })); setError(''); setShown(200); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const rows = result ? result.rows.filter((r) => kind === 'all' || r.kind === kind) : [];
  return (
    <Card>
      <SectionHeader title="Compare a zone file" description="Paste or upload the BIND zone file from the current DNS provider (at most 512 KB). It is compared with the records Cloudflare has for the zone now — read-only, nothing is saved or changed." />
      <div className="space-y-3 px-5 pb-5">
        <div className="flex flex-wrap items-start gap-4">
          <ZonePicker value={zone} onPick={setZone} />
          <div className="grid gap-1">
            <label htmlFor={fileId} className="text-[12px] text-muted">Zone file</label>
            <input id={fileId} type="file" accept=".txt,.zone,.db,.bind,text/plain" className="text-[13px] text-ink-2 file:mr-3 file:rounded-md file:border file:border-line-strong file:bg-raised file:px-2 file:py-1 file:text-ink" onChange={(e) => void load(e.target.files?.[0])} />
          </div>
        </div>
        <div className="grid gap-1">
          <label htmlFor={textId} className="text-[12px] text-muted">Or paste it</label>
          <textarea id={textId} className="input min-h-[140px] font-mono !text-[12px]" spellCheck={false} placeholder={'$ORIGIN example.com.\n$TTL 3600\n@   IN  A     192.0.2.10\nwww IN  CNAME example.com.'} value={text} onChange={(e) => setText(e.target.value.slice(0, MAX_BYTES))} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy} onClick={() => run(false)} icon={<GitCompare className="size-4" />} disabled={!text.trim()}>Compare</Button>
          {result && <Button variant="ghost" loading={busy} onClick={() => run(true)} icon={<RefreshCw className="size-4" />}>Read Cloudflare again</Button>}
        </div>
        {error && <Alert tone="bad">{error}</Alert>}
        {result && (
          <div className="space-y-3">
            <p className="text-[12.5px] text-muted">
              {whole.format(result.compared.file)} records in the file against {whole.format(result.compared.current)} on Cloudflare for <span className="font-mono text-ink-2">{result.zone}</span> ·
              Cloudflare read {result.cached ? 'from the last five minutes' : 'now'} (<span title={fmtDate(result.readAt)}>{new Date(result.readAt).toLocaleTimeString()}</span>). SOA and the apex NS are not compared.
            </p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
              <button type="button" aria-pressed={kind === 'all'} onClick={() => setKind('all')} className={cx('rounded-lg border px-2.5 py-1 text-[12.5px]', kind === 'all' ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted')}>All <span className="font-mono text-[11px] text-faint">{whole.format(result.rows.length)}</span></button>
              {KINDS.map((k) => (
                <button key={k.kind} type="button" aria-pressed={kind === k.kind} onClick={() => setKind(k.kind)} className={cx('rounded-lg border px-2.5 py-1 text-[12.5px]', kind === k.kind ? 'border-line-strong bg-raised text-ink' : 'border-transparent text-muted')}>
                  {k.label} <span className="font-mono text-[11px] text-faint">{whole.format(result.counts[k.kind])}</span>
                </button>
              ))}
            </div>
            {rows.length === 0 ? <Alert tone="ok">{kind === 'all' ? 'The file and Cloudflare have the same records.' : 'Nothing of this kind.'}</Alert> : (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full min-w-[820px] text-left text-[13px]">
                  <thead><tr className="border-b border-line text-muted">{['', 'Name', 'Type', 'In the file', 'On Cloudflare', 'Why'].map((h, i) => <th key={i} className="px-3 py-2 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}</tr></thead>
                  <tbody>{rows.slice(0, shown).map((r, i) => {
                    const k = KINDS.find((x) => x.kind === r.kind)!;
                    return (
                      <tr key={i} className="border-b border-line/60 align-top last:border-0">
                        <td className="px-3 py-1.5"><Badge tone={k.tone === 'neutral' ? 'neutral' : k.tone}>{k.label}</Badge></td>
                        <td className="px-3 py-1.5 font-mono text-[12px] break-all text-ink">{r.name}</td>
                        <td className="px-3 py-1.5 font-mono text-[12px]">{r.type}</td>
                        <td className="max-w-[260px] px-3 py-1.5 font-mono text-[12px] break-all text-ink-2">{r.file || '—'}</td>
                        <td className="max-w-[260px] px-3 py-1.5 font-mono text-[12px] break-all text-ink-2">{r.current || '—'}</td>
                        <td className="px-3 py-1.5 text-[12.5px] text-muted">{r.note}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
                {rows.length > shown && <div className="border-t border-line px-3 py-2 text-center"><Button size="sm" variant="ghost" onClick={() => setShown((n) => n + 200)}>Show more ({whole.format(rows.length - shown)} left)</Button></div>}
              </div>
            )}
            {result.errorCount > 0 && (
              <Alert tone="warn" title={`${whole.format(result.errorCount)} line${result.errorCount === 1 ? '' : 's'} of the file could not be read`}>
                <ul className="mt-1 space-y-0.5 font-mono text-[12px]">{result.errors.slice(0, 20).map((e, i) => <li key={i}>line {e.line}: {e.text}</li>)}</ul>
              </Alert>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function WatchDetail({ w }: { w: WatchView }) {
  const tone = w.status === 'active' && w.delegation === 'ok' ? 'ok' : w.delegation === 'elsewhere' || w.status === 'moved' ? 'bad' : 'warn';
  return (
    <div className="space-y-2 rounded-lg border border-line bg-raised/30 p-4 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium text-ink">{w.zone}</span>
        <Badge tone={tone}>{w.status}</Badge>
        <Badge tone={w.delegation === 'ok' ? 'ok' : w.delegation === 'unknown' ? 'neutral' : 'warn'}>delegation: {w.delegation}</Badge>
        <span className="text-faint">checked {new Date(w.checkedAt).toLocaleTimeString()}</span>
      </div>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[180px_1fr]">
        <dt className="text-muted">Must have (Cloudflare)</dt><dd className="font-mono text-[12px]">{w.assigned.join(', ') || '—'}</dd>
        <dt className="text-muted">Public DNS returns now</dt><dd className="font-mono text-[12px]">{w.seen.join(', ') || w.dnsStatus}</dd>
        {w.missing.length > 0 && <><dt className="text-muted">Still to add at the registrar</dt><dd className="font-mono text-[12px] text-warn">{w.missing.join(', ')}</dd></>}
        {w.extra.length > 0 && <><dt className="text-muted">Still to remove</dt><dd className="font-mono text-[12px] text-warn">{w.extra.join(', ')}</dd></>}
        {w.original.length > 0 && <><dt className="text-muted">Before Cloudflare</dt><dd className="font-mono text-[12px]">{w.original.join(', ')}{w.registrar ? ` · ${w.registrar}` : ''}</dd></>}
        <dt className="text-muted">Added</dt><dd>{w.createdOn ? fmtDate(w.createdOn) : '—'}{w.activatedOn ? ` · active since ${fmtDate(w.activatedOn)}` : ''}</dd>
      </dl>
      <p className="text-[12px] text-faint">Public DNS is asked through 1.1.1.1; registries can take up to 48 hours to publish a nameserver change. Cloudflare checks the nameservers on its own schedule.</p>
    </div>
  );
}

function Watch() {
  const toast = useToast();
  const { data, error, loading, reload } = useSnapshot<PendingView>('/api/onboarding/watch?limit=50');
  const [zone, setZone] = useState<{ id: string; name: string } | null>(null);
  const [checks, setChecks] = useState<Record<string, WatchView>>({});
  const [busy, setBusy] = useState('');
  const [extra, setExtra] = useState<PendingRow[]>([]);
  const check = async (id: string) => {
    setBusy(id);
    try { const w = await api<WatchView>(`/api/onboarding/watch?zone=${encodeURIComponent(id)}`); setChecks((c) => ({ ...c, [id]: w })); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(''); }
  };
  const rows = data ? [...data.rows, ...extra] : [];
  const more = async () => { const p = await api<PendingView>(`/api/onboarding/watch?limit=50&offset=${rows.length}`); setExtra((x) => [...x, ...p.rows]); };
  return (
    <Card>
      <SectionHeader title="Watch a zone" description="A zone’s status, the nameservers it must have, and what public DNS returns right now. Nothing refreshes on its own: press Check." aside={
        <Button size="sm" variant="ghost" loading={loading} onClick={() => { setExtra([]); void reload(); }} icon={<RefreshCw className="size-3.5" />}>Refresh</Button>} />
      <div className="space-y-4 px-5 pb-5">
        <div className="flex flex-wrap items-end gap-3">
          <ZonePicker value={zone} onPick={(z) => { setZone(z); void check(z.id); }} />
          {zone && <Button size="sm" loading={busy === zone.id} onClick={() => check(zone.id)} icon={<Radar className="size-3.5" />}>Check {zone.name}</Button>}
        </div>
        {zone && checks[zone.id] && <WatchDetail w={checks[zone.id]} />}
        <h3 className="pt-2 text-[14px] font-semibold">Zones not active yet {data && <span className="font-mono text-[11px] text-faint">{whole.format(data.total)}</span>}</h3>
        {error && <Alert tone="bad">{error}</Alert>}
        {!data ? <Loading label="Loading zones"><SkeletonTable rows={4} cols={5} /></Loading> : rows.length === 0 ? (
          <EmptyState icon={<Radar className="size-5" />} title="Every zone is active" description="As the DNS hygiene check last saw them. A zone added since then shows here after its next check — or check it above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead><tr className="border-b border-line text-muted">{['Zone', 'Account', 'Status', 'Delegation', 'Added', ''].map((h, i) => <th key={i} className="px-3 py-2 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}</tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.zoneId} className="border-b border-line/60 align-top last:border-0">
                  <td className="px-3 py-2"><span className="font-mono">{r.zone}</span>{checks[r.zoneId] && <div className="mt-2"><WatchDetail w={checks[r.zoneId]} /></div>}</td>
                  <td className="px-3 py-2 text-ink-2">{r.account}</td>
                  <td className="px-3 py-2"><Badge tone={r.status === 'moved' ? 'bad' : 'warn'}>{r.status}</Badge></td>
                  <td className="px-3 py-2 text-muted">{r.delegation}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{r.createdOn ? when(r.createdOn) : '—'}</td>
                  <td className="px-3 py-2 text-right"><Button size="sm" variant="ghost" loading={busy === r.zoneId} onClick={() => check(r.zoneId)} icon={<Radar className="size-3.5" />}>Check</Button></td>
                </tr>
              ))}</tbody>
            </table>
            {data.total > rows.length && <div className="border-t border-line px-3 py-2 text-center"><Button size="sm" variant="ghost" onClick={more}>Show more ({whole.format(data.total - rows.length)} left)</Button></div>}
          </div>
        )}
        {data && <p className="text-[12px] text-faint">List as of {new Date(data.generatedAt).toLocaleTimeString()}, from the DNS hygiene check.</p>}
      </div>
    </Card>
  );
}

export default function OnboardingPage() {
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="DNS" title="Zone onboarding" description="Before moving a zone’s nameservers to Cloudflare: check that Cloudflare has every record the current provider serves, then watch the delegation until the zone is active. Read-only." />
      <Compare />
      <Watch />
      <p className="flex items-center gap-1.5 text-[12px] text-faint"><FileUp className="size-3.5" /> Zone files are read in this browser and sent to the console only to compare; they are not stored.</p>
    </div>
  );
}
