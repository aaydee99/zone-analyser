'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Pencil, Plus, Power, RefreshCw, Search, Trash2, Zap } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import type { ChangeNote } from '@/lib/change-note';
import type { JobView, LogpushPage } from '@/lib/logpush';
import { ACCOUNT_DATASETS, LOGPUSH_STATUSES, STALE_HOURS, STATUS_LABEL, ZONE_DATASETS, type LogpushRow, type LogpushStatus } from '@/lib/logpush-types';
import { Alert, Badge, Button, Card, Field, Loading, Modal, PageHeader, SectionHeader, Skeleton, SkeletonTable, Stat, Switch, cx } from '@/components/ui';
import { ChangeNoteFields, noteBody, noteReady, useRequireReason } from '@/components/change-note';
import { EMPTY_CREDENTIAL, RuntimeCredentialFields, credentialBody, credentialReady, type RuntimeCredentialInput } from '@/components/runtime-credential';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { coverageLabel } from '../monitoring/use-run';

const PAGE = 50;
import { whole } from '@/lib/num';
const TONE: Record<LogpushStatus, 'bad' | 'warn' | 'neutral' | 'info' | 'ok'> = { failing: 'bad', stale: 'warn', disabled: 'neutral', waiting: 'info', healthy: 'ok' };

type Result = { done?: string; approval?: { id: string } };

function useSettled<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/**
 * Sends one Logpush action. A super admin's runs at once with the credential typed in (`cred`); an
 * admin's request carries none: the super admin who approves it types one in.
 */
async function sendAction(body: Record<string, unknown>, note: ChangeNote, direct: boolean, cred: RuntimeCredentialInput): Promise<Result> {
  return api<Result>('/api/cloudflare/actions', { method: 'POST', json: { type: 'logpush', ...body, ...(direct ? { cloudflare: credentialBody(cred) } : noteBody(note)) } });
}

function ResultNote({ r }: { r: Result }) {
  return r.done ? <Alert tone="ok" title="Done">{r.done}. The list shows it after the next check of that account or zone.</Alert>
    : <Alert tone="info" title="Waiting for approval">A super admin approves it on the <Link href="/console/approvals" className="text-signal underline">Approvals</Link> page.</Alert>;
}

// ── Create / edit ───────────────────────────────────────────────────────────

interface Form {
  name: string; enabled: boolean; dataset: string; filter: string; output: string;
  bytes: string; records: string; interval: string; destination: string; ownership: string;
}
const num = (v: number | null | undefined) => (v ? String(v) : '');
const formOf = (j: JobView | null): Form => ({
  name: j?.name ?? '', enabled: j ? !!j.enabled : true, dataset: j?.dataset ?? '', filter: j?.filter ?? '',
  output: j?.output_options ? JSON.stringify(j.output_options, null, 2) : '',
  bytes: num(j?.max_upload_bytes), records: num(j?.max_upload_records), interval: num(j?.max_upload_interval_seconds), destination: '', ownership: '',
});

/** The fields that differ from the job (all of them for a new one). Throws on bad JSON. */
function changesOf(f: Form, job: JobView | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const base = formOf(job);
  const n = (s: string) => (s.trim() ? Number(s) : 0);
  if (!job || f.name !== base.name) out.name = f.name.trim();
  if (!job || f.enabled !== base.enabled) out.enabled = f.enabled;
  if (!job) out.dataset = f.dataset.trim();
  if (f.filter.trim() !== base.filter.trim()) out.filter = f.filter.trim();
  if (f.output.trim() !== base.output.trim()) {
    try { out.output_options = f.output.trim() ? JSON.parse(f.output) : null; } catch { throw new Error('Output options must be JSON'); }
  }
  if (f.bytes !== base.bytes) out.max_upload_bytes = n(f.bytes);
  if (f.records !== base.records) out.max_upload_records = n(f.records);
  if (f.interval !== base.interval) out.max_upload_interval_seconds = n(f.interval);
  if (f.destination.trim()) out.destination_conf = f.destination.trim();
  if (f.ownership.trim()) out.ownership_challenge = f.ownership.trim();
  if (!job && !f.filter.trim()) delete out.filter;
  if (!job && !f.output.trim()) delete out.output_options;
  return out;
}

interface Scopes { accounts: { id: string; name: string }[]; zones: { id: string; name: string; accountName: string }[] }

/** Mounted fresh for each job (or new job), so its state starts empty. */
function JobModal({ row, onClose, direct }: { row: LogpushRow | null; onClose: () => void; direct: boolean }) {
  const toast = useToast();
  const requireReason = useRequireReason();
  const [job, setJob] = useState<JobView | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [form, setForm] = useState<Form>(formOf(null));
  const [scope, setScope] = useState<'account' | 'zone'>(row?.scopeKind ?? 'account');
  const [scopeId, setScopeId] = useState(row?.scopeId ?? '');
  const [zoneQ, setZoneQ] = useState('');
  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [note, setNote] = useState<ChangeNote>({});
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState<{ busy: boolean; text: string }>({ busy: false, text: '' });
  const [result, setResult] = useState<Result | null>(null);
  const [cred, setCred] = useState<RuntimeCredentialInput>(EMPTY_CREDENTIAL);
  const q = useSettled(zoneQ.trim());
  // The credential lives only in this dialog: cleared when it closes.
  const close = () => { setCred(EMPTY_CREDENTIAL); onClose(); };

  useEffect(() => {
    if (!row) return;
    let live = true;
    api<{ job: JobView }>(`/api/logpush/job?scope=${row.scopeKind}&scopeId=${encodeURIComponent(row.scopeId)}&jobId=${row.jobId}`)
      .then((r) => { if (live) { setJob(r.job); setForm(formOf(r.job)); } }).catch((e) => { if (live) setLoadErr((e as Error).message); });
    return () => { live = false; };
  }, [row]);
  useEffect(() => {
    if (row) return;
    let live = true;
    api<Scopes>(`/api/logpush/scopes?q=${encodeURIComponent(q)}`).then((r) => {
      if (!live) return;
      setScopes(r);
      setScopeId((id) => (scope === 'account' ? (r.accounts.some((a) => a.id === id) ? id : r.accounts[0]?.id ?? '') : (r.zones.some((z) => z.id === id) ? id : r.zones[0]?.id ?? '')));
    }).catch((e) => { if (live) setLoadErr((e as Error).message); });
    return () => { live = false; };
  }, [row, q, scope]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const ownership = async () => {
    setOwner({ busy: true, text: '' });
    try {
      const r = await api<{ filename: string; message: string; valid: boolean }>('/api/logpush/ownership', { method: 'POST', json: { scope, scopeId, destination_conf: form.destination, cloudflare: credentialBody(cred) } });
      setOwner({ busy: false, text: r.filename ? `Cloudflare wrote ${r.filename} to the destination: paste the token it holds below.` : r.message || 'Cloudflare wrote the challenge file to the destination.' });
    } catch (e) { setOwner({ busy: false, text: '' }); toast((e as Error).message, 'bad'); }
  };
  const submit = async () => {
    let changes: Record<string, unknown>;
    try { changes = changesOf(form, job); } catch (e) { toast((e as Error).message, 'bad'); return; }
    if (job && !Object.keys(changes).length) { toast('Nothing would change', 'info'); return; }
    setBusy(true);
    try {
      const r = await sendAction({ op: job ? 'update' : 'create', scope, scopeId, ...(job ? { jobId: job.id } : {}), changes }, note, direct, cred);
      setResult(r);
      setCred(EMPTY_CREDENTIAL);
      setForm((f) => ({ ...f, destination: '', ownership: '' }));
      toast(r.done ?? 'Sent to a super admin for approval', r.done ? 'ok' : 'info');
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };

  const datasets = scope === 'zone' ? ZONE_DATASETS : ACCOUNT_DATASETS;
  const editing = !!row;
  const ready = editing ? !!job : !!scopeId && !!form.dataset.trim() && !!form.destination.trim();
  return (
    <Modal open onClose={close} width="max-w-2xl"
      title={editing ? `Edit Logpush job “${row?.job}”` : 'New Logpush job'}
      description={editing ? `${row?.scope} ${row?.scopeName} · ${row?.dataset}. Read from Cloudflare just now.` : 'Cloudflare checks the destination when the change runs.'}
      footer={result ? <Button onClick={close}>Close</Button> : <><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ready || (direct ? !credentialReady(cred) : !noteReady(note, requireReason))} onClick={submit}>{direct ? (editing ? 'Save in Cloudflare' : 'Create in Cloudflare') : 'Ask for approval'}</Button></>}>
      {result ? <ResultNote r={result} /> : loadErr ? <Alert tone="bad">{loadErr}</Alert> : editing && !job ? <Loading label="Reading the job"><Skeleton className="h-64 w-full" /></Loading> : (
        <div className="space-y-4">
          {!editing && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="For">
                <select className="input" value={scope} onChange={(e) => { setScope(e.target.value as 'account' | 'zone'); setScopeId(''); }}>
                  <option value="account">An account</option>
                  <option value="zone">A zone</option>
                </select>
              </Field>
              {scope === 'account' ? (
                <Field label="Account">
                  <select className="input" value={scopeId} onChange={(e) => setScopeId(e.target.value)} disabled={!scopes}>
                    {scopes?.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </Field>
              ) : (
                <Field label="Zone" hint="Search by name (50 shown)">
                  <div className="space-y-2">
                    <input className="input" aria-label="Search zones" value={zoneQ} onChange={(e) => setZoneQ(e.target.value)} placeholder="example.com" />
                    <select className="input" aria-label="Zone" value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                      {scopes?.zones.map((z) => <option key={z.id} value={z.id}>{z.name}{z.accountName ? ` — ${z.accountName}` : ''}</option>)}
                    </select>
                  </div>
                </Field>
              )}
              <Field label="Dataset">
                <input className="input font-mono" list="logpush-datasets" value={form.dataset} onChange={(e) => set('dataset', e.target.value)} spellCheck={false} />
              </Field>
              <datalist id="logpush-datasets">{datasets.map((d) => <option key={d} value={d} />)}</datalist>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Field label="Name" optional hint="Letters, digits, dots and dashes">
              <input className="input font-mono" value={form.name} maxLength={512} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <div className="flex items-center gap-2 pt-6"><Switch checked={form.enabled} onChange={(v) => set('enabled', v)} label="Enabled" /><span className="text-sm text-ink-2">Enabled</span></div>
          </div>
          <Field label={editing ? `New destination${job ? ` (now ${job.destination || 'unknown'})` : ''}` : 'Destination'} optional={editing}
            hint="e.g. s3://bucket/logs?region=us-east-1&access-key-id=…&secret-access-key=… — sealed in the request and never shown again; only its host is displayed">
            <div className="flex gap-2">
              <input className="input flex-1 font-mono !text-[12.5px]" value={form.destination} onChange={(e) => set('destination', e.target.value)} autoComplete="off" spellCheck={false} maxLength={4096} />
              <Button type="button" size="sm" className="!h-10" onClick={ownership} loading={owner.busy} disabled={!form.destination.trim() || !scopeId || !credentialReady(cred)} title={credentialReady(cred) ? undefined : 'Enter a Cloudflare credential below first'}>Ownership challenge</Button>
            </div>
          </Field>
          {owner.text && <Alert tone="info">{owner.text}</Alert>}
          <Field label="Ownership challenge token" optional hint="Needed for S3, Google Cloud Storage, Azure and some others when the destination is new">
            <input className="input font-mono !text-[12.5px]" value={form.ownership} onChange={(e) => set('ownership', e.target.value)} autoComplete="off" spellCheck={false} maxLength={4096} />
          </Field>
          <Field label="Filter" optional hint='JSON, e.g. {"where":{"key":"ClientRequestHost","operator":"eq","value":"example.com"}}'>
            <textarea className="input min-h-[72px] font-mono !text-[12.5px]" value={form.filter} onChange={(e) => set('filter', e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Output options" optional hint='JSON, e.g. {"output_type":"ndjson","field_names":["ClientIP","EdgeStartTimestamp"],"sample_rate":0.1}'>
            <textarea className="input min-h-[96px] font-mono !text-[12.5px]" value={form.output} onChange={(e) => set('output', e.target.value)} spellCheck={false} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Max batch bytes" optional hint="5,000,000–1,000,000,000; 0 off"><input className="input" inputMode="numeric" value={form.bytes} onChange={(e) => set('bytes', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Max records" optional hint="1,000–1,000,000; 0 off"><input className="input" inputMode="numeric" value={form.records} onChange={(e) => set('records', e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Max seconds" optional hint="30–300; 0 off"><input className="input" inputMode="numeric" value={form.interval} onChange={(e) => set('interval', e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
          {!direct && <ChangeNoteFields value={note} onChange={setNote} requireReason={requireReason} />}
          <RuntimeCredentialFields value={cred} onChange={setCred} scope={scope} />
          {!direct && <p className="text-xs text-muted">Your request carries no credential: it is used only for the ownership challenge. The super admin who approves types one in.</p>}
        </div>
      )}
    </Modal>
  );
}

/** Turning a job on or off, or deleting it. */
/** Mounted fresh for each job and choice. */
function ConfirmModal({ row, mode, onClose, direct }: { row: LogpushRow; mode: 'toggle' | 'delete'; onClose: () => void; direct: boolean }) {
  const toast = useToast();
  const requireReason = useRequireReason();
  const [note, setNote] = useState<ChangeNote>({});
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [cred, setCred] = useState<RuntimeCredentialInput>(EMPTY_CREDENTIAL);
  const close = () => { setCred(EMPTY_CREDENTIAL); onClose(); };
  const del = mode === 'delete';
  const submit = async () => {
    setBusy(true);
    try {
      const r = await sendAction({ op: del ? 'delete' : 'update', scope: row.scopeKind, scopeId: row.scopeId, jobId: row.jobId, ...(del ? {} : { changes: { enabled: !row.enabled } }) }, note, direct, cred);
      setResult(r);
      setCred(EMPTY_CREDENTIAL);
      toast(r.done ?? 'Sent to a super admin for approval', r.done ? 'ok' : 'info');
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  const verb = del ? 'Delete' : row.enabled ? 'Turn off' : 'Turn on';
  return (
    <Modal open onClose={close} title={`${verb} Logpush job “${row.job}”?`} description={`${row.scope} ${row.scopeName} · ${row.dataset} → ${row.destination}`}
      footer={result ? <Button onClick={close}>Close</Button> : <><Button variant="ghost" onClick={close}>Cancel</Button><Button variant={del ? 'danger' : 'primary'} loading={busy} disabled={(del && typed.trim() !== row.job) || (direct ? !credentialReady(cred) : !noteReady(note, requireReason))} onClick={submit}>{direct ? verb : 'Ask for approval'}</Button></>}>
      {result ? <ResultNote r={result} /> : (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">{del ? 'Cloudflare stops pushing these logs and the job is gone; the destination keeps what it already has.' : row.enabled ? 'Cloudflare stops pushing these logs until the job is turned on again.' : 'Cloudflare starts pushing these logs again.'}</p>
          {del && <Field label={`Type ${row.job} to confirm`}><input className="input font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus /></Field>}
          {!direct && <ChangeNoteFields value={note} onChange={setNote} requireReason={requireReason} />}
          {direct && <RuntimeCredentialFields value={cred} onChange={setCred} scope={row.scopeKind} />}
        </div>
      )}
    </Modal>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

export default function LogpushPage() {
  const { can } = useMe();
  const toast = useToast();
  const act = can('cloudflare:act');
  const direct = can('restore:approve');
  const [status, setStatus] = useState<LogpushStatus | ''>('');
  const [scope, setScope] = useState<'' | 'account' | 'zone'>('');
  const [q, setQ] = useState('');
  const term = useSettled(q.trim());
  const [data, setData] = useState<LogpushPage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [checking, setChecking] = useState(false);
  const [edit, setEdit] = useState<{ row: LogpushRow | null } | null>(null);
  const [confirm, setConfirm] = useState<{ row: LogpushRow; mode: 'toggle' | 'delete' } | null>(null);

  const url = useCallback((offset: number) => `/api/logpush?offset=${offset}&limit=${offset ? PAGE * 4 : PAGE}${status ? `&status=${status}` : ''}${scope ? `&scope=${scope}` : ''}${term ? `&q=${encodeURIComponent(term)}` : ''}`, [status, scope, term]);
  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await api<LogpushPage>(url(0))); setError(''); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [url]);
  useEffect(() => { void reload(); }, [reload]);
  const loadMore = async () => {
    if (!data) return;
    setMore(true);
    try { const p = await api<LogpushPage>(url(data.rows.length)); setData({ ...p, rows: [...data.rows, ...p.rows] }); } catch (e) { toast((e as Error).message, 'bad'); } finally { setMore(false); }
  };
  const checkNow = async () => {
    setChecking(true);
    try { await api('/api/monitors/run', { method: 'POST', json: { checks: ['logpush'] } }); toast('Checking every account and zone — press Refresh in a while', 'info'); } catch (e) { toast((e as Error).message, 'bad'); } finally { setChecking(false); }
  };

  const c = data?.counts ?? {};
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Cloudflare" title="Logpush"
        description={<>Every Logpush job of every account and zone, as monitoring last read them. Failing: an error newer than the last push. Stale: nothing pushed for {STALE_HOURS} hours. Destinations show their host only.{act ? (direct ? ' Changes run at once, with an API token or Global API Key you type in each time (never a stored token), and are audited.' : ' Changes wait for a super admin’s approval; they type in the credential the change runs with.') : ''}</>}
        actions={<>
          {can('monitors:manage') && <Button variant="ghost" onClick={checkNow} loading={checking} icon={<Zap className="size-4" />}>Check now</Button>}
          <Button variant="ghost" onClick={reload} loading={loading} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {act && <Button variant="primary" onClick={() => setEdit({ row: null })} icon={<Plus className="size-4" />}>New job</Button>}
        </>} />
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Jobs" value={whole.format(c.jobs ?? 0)} sub={data ? coverageLabel(data.coverage) : undefined} />
        <Stat label="Failing" value={whole.format(c.failing ?? 0)} tone={c.failing ? 'bad' : 'ok'} />
        <Stat label="Stale" value={whole.format(c.stale ?? 0)} tone={c.stale ? 'warn' : 'ok'} />
        <Stat label="Turned off" value={whole.format(c.disabled ?? 0)} tone={c.disabled ? 'warn' : undefined} sub={data?.coverage.lastRun ? `As of ${fmtDate(data.coverage.lastRun)}` : 'Not checked yet'} />
      </div>
      <Card>
        <SectionHeader title="Jobs" description="Worst first." aside={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            <select className="input !h-8 !w-auto !py-0 !text-[13px]" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as LogpushStatus | '')}>
              <option value="">Every status</option>
              {LOGPUSH_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <select className="input !h-8 !w-auto !py-0 !text-[13px]" aria-label="Accounts or zones" value={scope} onChange={(e) => setScope(e.target.value as '' | 'account' | 'zone')}>
              <option value="">Accounts and zones</option>
              <option value="account">Accounts</option>
              <option value="zone">Zones</option>
            </select>
            <label className="relative block w-48 sm:w-56">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
              <input className="input !py-1.5 !pl-8 !text-[13px]" placeholder="Search jobs" aria-label="Search jobs" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          </div>
        )} />
        {!data ? <div className="p-5"><SkeletonTable rows={6} cols={6} /></div> : !data.rows.length ? (
          <p className="px-5 py-10 text-center text-sm text-muted">{status || scope || term ? 'Nothing matches.' : data.coverage.targets ? 'No Logpush jobs in the accounts and zones read.' : 'Monitoring has not read Logpush yet.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-muted">
                  {['Job', 'Where', 'Dataset', 'Destination', 'Status', 'Last push', 'Last error'].map((h) => <th key={h} className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}
                  {act && <th className="px-4 py-2.5"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.scopeKind}:${r.scopeId}:${r.jobId}`} className={cx('border-b border-line/60 align-top last:border-0 hover:bg-raised/40', r.status === 'failing' && 'bg-bad/[0.03]')}>
                    <td className="px-4 py-2.5 font-mono text-ink">{r.job}{r.filtered && <span className="ml-1.5 text-[11px] text-faint">filtered</span>}</td>
                    <td className="px-4 py-2.5"><span className="text-ink-2">{r.scopeName}</span><span className="block text-[11.5px] text-faint">{r.scope}{r.scopeKind === 'zone' && r.accountName ? ` · ${r.accountName}` : ''}</span></td>
                    <td className="px-4 py-2.5 font-mono text-[12px]">{r.dataset}</td>
                    <td className="max-w-[220px] truncate px-4 py-2.5 font-mono text-[12px]" title={r.destination}>{r.destination}</td>
                    <td className="px-4 py-2.5"><Badge tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge></td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-ink-2">{r.lastComplete ? fmtDate(r.lastComplete) : '—'}</td>
                    <td className="max-w-[320px] px-4 py-2.5"><span className="whitespace-nowrap text-ink-2">{r.lastError ? fmtDate(r.lastError) : '—'}</span>{r.error && <span className="mt-0.5 block text-[12px] text-bad" title={r.error}>{r.error}</span>}</td>
                    {act && (
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        <Button size="sm" variant="ghost" aria-label={`Edit ${r.job}`} onClick={() => setEdit({ row: r })} icon={<Pencil className="size-3.5" />} />
                        <Button size="sm" variant="ghost" aria-label={`${r.enabled ? 'Turn off' : 'Turn on'} ${r.job}`} onClick={() => setConfirm({ row: r, mode: 'toggle' })} icon={<Power className="size-3.5" />} />
                        <Button size="sm" variant="ghost" aria-label={`Delete ${r.job}`} onClick={() => setConfirm({ row: r, mode: 'delete' })} icon={<Trash2 className="size-3.5" />} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {data.total > data.rows.length && (
              <div className="border-t border-line px-4 py-2.5 text-center">
                <Button size="sm" variant="ghost" loading={more} onClick={loadMore}>Show more ({whole.format(data.total - data.rows.length)} left)</Button>
              </div>
            )}
          </div>
        )}
      </Card>
      {act && edit && <JobModal key={edit.row ? `${edit.row.scopeKind}:${edit.row.scopeId}:${edit.row.jobId}` : 'new'} row={edit.row} onClose={() => setEdit(null)} direct={direct} />}
      {act && confirm && <ConfirmModal key={`${confirm.mode}:${confirm.row.scopeKind}:${confirm.row.scopeId}:${confirm.row.jobId}`} row={confirm.row} mode={confirm.mode} onClose={() => setConfirm(null)} direct={direct} />}
    </div>
  );
}
