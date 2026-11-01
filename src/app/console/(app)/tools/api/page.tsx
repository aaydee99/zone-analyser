'use client';

import { compactNum } from '@/lib/num';
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, Bookmark, ChevronDown, ChevronRight, Copy, Play, Trash2 } from 'lucide-react';
import { api, copyText } from '@/lib/client';
import { COMMON_PATHS, MAX_RESPONSE_BYTES, PathError, checkPath, fillPath } from '@/lib/api-console-paths';
import type { QueryResult, SavedQuery } from '@/lib/api-console';
import { Alert, Badge, Button, Card, Field, Loading, PageHeader, SectionHeader, Skeleton, cx } from '@/components/ui';
import { useToast } from '@/components/toast';

interface Named { id: string; name: string }
interface ZoneOpt { id: string; name: string; accountId: string; accountName: string }

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
/** Items of a list shown before "show more". */
const SLICE = 100;

/** A collapsible JSON tree. Levels below `open` start collapsed. */
const JsonNode = memo(function JsonNode({ name, value, depth, open }: { name?: string; value: unknown; depth: number; open: number }) {
  const [expanded, setExpanded] = useState(depth < open);
  const [limit, setLimit] = useState(SLICE);
  const label = name !== undefined ? <span className="text-info">{JSON.stringify(name)}<span className="text-faint">: </span></span> : null;
  if (value === null || typeof value !== 'object') {
    const cls = typeof value === 'string' ? 'text-ok' : typeof value === 'number' ? 'text-signal' : typeof value === 'boolean' ? 'text-warn' : 'text-faint';
    return <div className="break-all">{label}<span className={cls}>{JSON.stringify(value)}</span></div>;
  }
  const isArr = Array.isArray(value);
  const entries: [string, unknown][] = isArr ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>);
  const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
  if (!entries.length) return <div>{label}<span className="text-faint">{o}{c}</span></div>;
  return (
    <div>
      <button type="button" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded} className="inline-flex items-center gap-0.5 rounded text-left hover:bg-raised">
        {expanded ? <ChevronDown className="size-3 text-faint" /> : <ChevronRight className="size-3 text-faint" />}
        {label}<span className="text-faint">{o}{!expanded && ` ${entries.length} ${isArr ? 'items' : 'keys'} ${c}`}</span>
      </button>
      {expanded && (
        <div className="ml-2 border-l border-line pl-3">
          {entries.slice(0, limit).map(([k, v]) => <JsonNode key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} open={open} />)}
          {entries.length > limit && <button type="button" className="text-signal hover:underline" onClick={() => setLimit((l) => l + SLICE * 5)}>Show more ({entries.length - limit} left)</button>}
        </div>
      )}
      {expanded && <span className="text-faint">{c}</span>}
    </div>
  );
});

export default function ApiConsolePage() {
  const toast = useToast();
  const [creds, setCreds] = useState<Named[] | null>(null);
  const [credentialId, setCredentialId] = useState('');
  const [loaded, setLoaded] = useState<{ for: string; list: Named[] } | null>(null);
  const accounts = loaded?.for === credentialId ? loaded.list : null;
  const [accountId, setAccountId] = useState('');
  const [zoneQ, setZoneQ] = useState('');
  const [zones, setZones] = useState<{ zones: ZoneOpt[]; total: number } | null>(null);
  const [zoneId, setZoneId] = useState('');
  const [path, setPath] = useState('/zones/{zone_id}/dns_records?per_page=100');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<SavedQuery[] | null>(null);
  const [savedError, setSavedError] = useState('');
  const [saveName, setSaveName] = useState('');
  const [openDepth, setOpenDepth] = useState(2);
  const [treeKey, setTreeKey] = useState(0);

  useEffect(() => {
    api<{ credentials: Named[] }>('/api/tools/api-console').then((r) => { setCreds(r.credentials); setCredentialId((c) => c || r.credentials[0]?.id || ''); }).catch((e) => setError((e as Error).message));
    api<{ saved: SavedQuery[] }>('/api/tools/api-console/saved').then((r) => setSaved(r.saved)).catch((e) => { setSaved([]); setSavedError((e as Error).message); });
  }, []);
  useEffect(() => {
    if (!credentialId) return;
    let live = true;
    api<{ accounts: Named[] }>(`/api/tools/api-console/accounts?credentialId=${encodeURIComponent(credentialId)}`)
      .then((r) => { if (live) { setLoaded({ for: credentialId, list: r.accounts }); setAccountId((a) => (r.accounts.some((x) => x.id === a) ? a : r.accounts[0]?.id ?? '')); } })
      .catch((e) => { if (live) { setLoaded({ for: credentialId, list: [] }); toast((e as Error).message, 'bad'); } });
    return () => { live = false; };
  }, [credentialId, toast]);
  useEffect(() => {
    if (!credentialId) return;
    let live = true;
    const t = setTimeout(() => {
      api<{ zones: ZoneOpt[]; total: number }>(`/api/tools/api-console/zones?credentialId=${encodeURIComponent(credentialId)}&accountId=${encodeURIComponent(accountId)}&q=${encodeURIComponent(zoneQ.trim())}&limit=50`)
        .then((r) => { if (live) { setZones(r); setZoneId((z) => (r.zones.some((x) => x.id === z) ? z : r.zones[0]?.id ?? '')); } })
        .catch(() => { if (live) setZones({ zones: [], total: 0 }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [credentialId, accountId, zoneQ]);

  const preview = useMemo(() => {
    try { return { path: checkPath(fillPath(path, { accountId, zoneId })), error: '' }; } catch (e) { return { path: '', error: e instanceof PathError ? e.message : String(e) }; }
  }, [path, accountId, zoneId]);

  const run = useCallback(async (p = path) => {
    setBusy(true); setError('');
    try {
      const r = await api<QueryResult>('/api/tools/api-console/query', { method: 'POST', json: { credentialId, path: p, accountId, zoneId } });
      setResult(r); setTreeKey((k) => k + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [path, credentialId, accountId, zoneId]);

  const save = async () => {
    try {
      const s = await api<SavedQuery>('/api/tools/api-console/saved', { method: 'POST', json: { name: saveName.trim(), path } });
      setSaved((l) => [s, ...(l ?? [])]); setSaveName(''); toast('Saved', 'ok');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const remove = async (id: string) => {
    try { await api(`/api/tools/api-console/saved/${id}`, { method: 'DELETE' }); setSaved((l) => (l ?? []).filter((x) => x.id !== id)); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const copy = async () => {
    if (!result) return;
    try { await copyText(result.body !== undefined ? JSON.stringify(result.body, null, 2) : result.text ?? ''); toast('Copied', 'ok'); } catch { toast('Could not copy', 'bad'); }
  };
  const nextPage = () => { if (result?.next) { setPath(result.next); void run(result.next); } };

  let body: ReactNode = null;
  if (result) {
    body = result.body !== undefined
      ? <div key={treeKey} className="overflow-x-auto px-5 py-4 font-mono text-[12.5px] leading-relaxed"><JsonNode value={result.body} depth={0} open={openDepth} /></div>
      : <pre className="max-h-[70vh] overflow-auto px-5 py-4 font-mono text-[12px] whitespace-pre-wrap break-all text-ink-2">{result.text}</pre>;
  }

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Tools" title="API console"
        description="Read the Cloudflare API with a stored token: GET only, under /client/v4. Secret-looking values are masked, answers over 2 MB are cut, and each call is recorded in the audit log (its path, never the answer)." />
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <SectionHeader title="Request" />
            <form className="space-y-4 px-5 py-4" onSubmit={(e) => { e.preventDefault(); if (!preview.error) void run(); }}>
              <div className="grid gap-4 md:grid-cols-3">
                {!creds ? <Loading label="Loading credentials"><Skeleton className="h-10 w-full rounded-[9px]" /></Loading> : (
                  <Field label="Credential">
                    <select className="input" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                      {!creds.length && <option value="">No Cloudflare credential stored</option>}
                      {creds.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Account" hint="Fills {account_id}">
                  <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!accounts}>
                    {!accounts?.length && <option value="">{accounts ? 'No account' : 'Loading…'}</option>}
                    {accounts?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
                <Field label="Zone" hint={zones ? `Fills {zone_id} · ${compactNum(zones.total)} zone${zones.total === 1 ? '' : 's'}${zones.total > zones.zones.length ? ' (search to narrow)' : ''}` : 'Fills {zone_id}'}>
                  <div className="space-y-2">
                    <input className="input" aria-label="Search zones" placeholder="Search zones" value={zoneQ} onChange={(e) => setZoneQ(e.target.value)} />
                    <select className="input" aria-label="Zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                      {!zones?.zones.length && <option value="">No zone</option>}
                      {zones?.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                    </select>
                  </div>
                </Field>
              </div>
              <Field label="GET path" htmlFor="api-path" error={path.trim() ? preview.error || undefined : undefined}
                hint={preview.path ? <span className="font-mono">https://api.cloudflare.com/client/v4{preview.path}</span> : 'Type / to see common reads'}>
                <div className="flex gap-2">
                  <span className="inline-flex h-10 items-center rounded-[9px] border border-line bg-sunken px-3 font-mono text-[12px] text-faint">GET</span>
                  <input id="api-path" className="input flex-1 font-mono !text-[13px]" list="api-paths" value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} autoComplete="off" maxLength={1024} />
                  <datalist id="api-paths">{COMMON_PATHS.map((p) => <option key={p.path} value={p.path}>{p.label}</option>)}</datalist>
                  <Button type="submit" variant="primary" loading={busy} disabled={!credentialId || !!preview.error} icon={<Play className="size-4" />}>Run</Button>
                </div>
              </Field>
            </form>
          </Card>
          {result && (
            <Card>
              <SectionHeader title="Answer" description={`${result.path} · ${result.ms} ms · ${kb(result.bytes)}`} aside={(
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Badge tone={result.ok ? 'ok' : 'bad'}>HTTP {result.status || '—'}</Badge>
                  {result.body !== undefined && (
                    <select className="input !h-8 !w-auto !py-0 !text-[12.5px]" aria-label="Expand levels" value={openDepth} onChange={(e) => { setOpenDepth(Number(e.target.value)); setTreeKey((k) => k + 1); }}>
                      {[1, 2, 3, 5, 99].map((d) => <option key={d} value={d}>{d === 99 ? 'Expand all' : `Expand ${d} level${d === 1 ? '' : 's'}`}</option>)}
                    </select>
                  )}
                  <Button size="sm" variant="ghost" onClick={copy} icon={<Copy className="size-3.5" />}>Copy</Button>
                  {result.next && <Button size="sm" onClick={nextPage} loading={busy} icon={<ArrowRight className="size-3.5" />}>Next page</Button>}
                </div>
              )} />
              {result.truncated && <div className="px-5 pt-4"><Alert tone="warn" title="Answer cut">The answer is {kb(result.bytes)}; the first {kb(MAX_RESPONSE_BYTES)} are shown as text. Ask for fewer items (per_page) or a narrower path.</Alert></div>}
              {result.info && (result.info.total_count !== undefined || result.info.total_pages !== undefined) && (
                <p className="px-5 pt-3 text-[12.5px] text-muted">
                  {result.info.page !== undefined && `Page ${result.info.page}${result.info.total_pages ? ` of ${result.info.total_pages}` : ''}`}
                  {result.info.total_count !== undefined && ` · ${compactNum(result.info.total_count)} in all`}
                </p>
              )}
              {body}
            </Card>
          )}
        </div>
        <Card className="self-start">
          <SectionHeader title="Saved queries" description="Yours only. Paths keep their placeholders." />
          <div className="space-y-3 px-5 py-4">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (saveName.trim()) void save(); }}>
              <input className="input !text-[13px]" aria-label="Name for this query" placeholder="Name this path" value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={100} />
              <Button type="submit" size="sm" disabled={!saveName.trim() || !!preview.error} icon={<Bookmark className="size-3.5" />}>Save</Button>
            </form>
            {savedError && <p className="text-xs text-bad">{savedError}</p>}
            {!saved ? <Loading label="Loading saved queries"><Skeleton className="h-16 w-full" /></Loading> : !saved.length ? <p className="text-[13px] text-muted">None yet.</p> : (
              <ul className="divide-y divide-line/60">
                {saved.map((s) => (
                  <li key={s.id} className="flex items-start gap-2 py-2">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setPath(s.path)}>
                      <span className="block truncate text-[13px] text-ink">{s.name}</span>
                      <span className={cx('block truncate font-mono text-[11.5px] text-faint')} title={s.path}>{s.path}</span>
                    </button>
                    <button type="button" className="rounded p-1 text-faint hover:bg-raised hover:text-bad" aria-label={`Delete ${s.name}`} onClick={() => remove(s.id)}><Trash2 className="size-3.5" /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
