'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BellPlus, CheckCheck, Undo2 } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import type { ZoneListItem } from '@/lib/zone-catalog';
import { Alert, Badge, Button, Card, Field, Modal, SectionHeader } from '@/components/ui';
import { useToast } from '@/components/toast';

// Actions on some check pages: accept drift, connect Cloudflare's alerts, roll a deployment back.

/** Accepts the current state of one zone (or of all zones) as the drift baseline. */
export function DriftAccept({ zoneId, zoneName, onDone, compact = false }: { zoneId?: string; zoneName?: string; onDone: () => void; compact?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ accepted: string[]; count: number }>('/api/monitors/drift/accept', { method: 'POST', json: zoneId ? { zoneId } : {} });
      toast(`Accepted ${r.count === 1 ? r.accepted[0] : `${r.count.toLocaleString()} zones`} as the new baseline`, 'ok');
      setOpen(false);
      onDone();
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(false); }
  };
  const what = zoneName ? `the current state of ${zoneName}` : 'the current state of every zone';
  return (
    <>
      {compact
        ? <Button size="sm" variant="ghost" onClick={() => setOpen(true)} icon={<CheckCheck className="size-3.5" />}>Accept</Button>
        : (
          <Card className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
            <p className="text-[13px] text-muted">Reviewed the changes below? Accept them as the new baseline, and drift starts from here.</p>
            <Button onClick={() => setOpen(true)} icon={<CheckCheck className="size-4" />}>Accept all as baseline</Button>
          </Card>
        )}
      <Modal open={open} onClose={() => setOpen(false)} title="Accept as the new baseline?" description={`Drift will compare against ${what} from now on.`}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={go}>Accept</Button></>}>
        <p className="text-[13px] text-muted">The changes stop showing as drift and their findings close. Nothing changes in Cloudflare. To undo a change instead, restore the zone from a backup.</p>
      </Modal>
    </>
  );
}

interface AccountOption { id: string; name: string }

function useAccounts() {
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);
  useEffect(() => {
    api<{ zones: ZoneListItem[] }>('/api/zone-explorer').then((r) => {
      const m = new Map<string, string>();
      for (const z of r.zones) if (z.accountId) m.set(z.accountId, z.accountName || z.accountId);
      setAccounts([...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => setAccounts([]));
  }, []);
  return accounts;
}

/** Adds the console as a webhook destination in a Cloudflare account (super admins). */
export function AlertsConnect() {
  const toast = useToast();
  const accounts = useAccounts();
  const [accountId, setAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const connect = async () => {
    setBusy(true);
    try {
      const r = await api<{ url: string }>('/api/monitors/alerts/connect', { method: 'POST', json: { accountId, origin: window.location.origin } });
      setDone(r.url);
      toast('Connected — Cloudflare sent a test message to the console', 'ok');
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(false); }
  };
  return (
    <Card>
      <SectionHeader title="Receive Cloudflare’s alerts here" description="Adds this console as a webhook destination in a Cloudflare account. Then, in Cloudflare › Notifications, choose which alerts go to it." />
      <div className="flex flex-wrap items-end gap-3 px-5 py-4">
        <div className="min-w-[240px] flex-1">
          <Field label="Cloudflare account" htmlFor="alerts-account">
            <select id="alerts-account" className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!accounts?.length}>
              <option value="">{accounts === null ? 'Loading accounts…' : accounts.length ? 'Choose an account' : 'No accounts found'}</option>
              {accounts?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </div>
        <Button variant="primary" disabled={!accountId} loading={busy} onClick={connect} icon={<BellPlus className="size-4" />}>Connect</Button>
      </div>
      {done && <div className="px-5 pb-4"><Alert tone="ok" title="Connected">Cloudflare delivers to <span className="font-mono">{done}</span>. The stored token needed Notifications Edit for this; reading alerts later needs only Notifications Read.</Alert></div>}
    </Card>
  );
}

interface Version { id: string; label: string; createdOn: string | null; author?: string; source?: string; message?: string; commit?: string; branch?: string; url?: string; current: boolean }

/** Rolls a Worker or a Pages project back to an earlier version (an approved action for admins). */
export function RollbackButton({ kind, accountId, name }: { kind: 'workers' | 'pages'; accountId: string; name: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Version[] | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ done?: string; approval?: { id: string } } | null>(null);
  const load = async () => {
    setOpen(true); setList(null); setError(''); setPick(''); setSent(null);
    try {
      const path = kind === 'workers' ? `/api/cloudflare/workers/${accountId}/${encodeURIComponent(name)}` : `/api/cloudflare/pages/${accountId}/${encodeURIComponent(name)}`;
      const r = await api<{ versions?: Version[]; deployments?: Version[] }>(path);
      setList(r.versions ?? r.deployments ?? []);
    } catch (err) { setError((err as Error).message); }
  };
  const chosen = useMemo(() => list?.find((v) => v.id === pick), [list, pick]);
  const submit = async () => {
    setBusy(true);
    try {
      const body = kind === 'workers' ? { type: 'worker-rollback', accountId, script: name, versionId: pick } : { type: 'pages-rollback', accountId, project: name, deploymentId: pick };
      const r = await api<{ done?: string; approval?: { id: string } }>('/api/cloudflare/actions', { method: 'POST', json: body });
      setSent(r);
      toast(r.done ?? 'Sent to a super admin for approval', r.done ? 'ok' : 'info');
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(false); }
  };
  if (!accountId) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={load} icon={<Undo2 className="size-3.5" />}>Roll back</Button>
      <Modal open={open} onClose={() => setOpen(false)} width="max-w-2xl" title={`Roll ${kind === 'workers' ? 'Worker' : 'Pages project'} “${name}” back`}
        description={kind === 'workers' ? 'Deploys an earlier version to all traffic. Bindings and secrets are not rolled back.' : 'Makes an earlier production deployment live again.'}
        footer={sent ? <Button onClick={() => setOpen(false)}>Close</Button> : <><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!chosen} loading={busy} onClick={submit}>Roll back to {chosen?.label ?? '…'}</Button></>}>
        {sent ? (
          sent.done ? <Alert tone="ok" title="Done">{sent.done}</Alert>
            : <Alert tone="info" title="Waiting for approval">A super admin approves it on the <Link href="/console/approvals" className="text-signal underline">Approvals</Link> page; it runs as soon as it is approved.</Alert>
        ) : error ? <Alert tone="bad" title="Versions could not be read">{error}</Alert> : !list ? <p className="text-sm text-muted">Reading versions…</p> : !list.length ? <p className="text-sm text-muted">No earlier versions to go back to.</p> : (
          <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto pr-1" role="radiogroup" aria-label="Version">
            {list.map((v) => (
              <li key={v.id}>
                <label className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 ${pick === v.id ? 'border-signal bg-signal/5' : 'border-line hover:border-line-strong'} ${v.current ? 'cursor-not-allowed opacity-60' : ''}`}>
                  <input type="radio" name="version" className="mt-1" value={v.id} checked={pick === v.id} disabled={v.current} onChange={() => setPick(v.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className="font-mono font-medium">{v.label}</span>
                      {v.current && <Badge tone="ok">live now</Badge>}
                      <span className="text-muted" title={v.createdOn ? fmtDate(v.createdOn) : undefined}>{v.createdOn ? relTime(v.createdOn) : ''}</span>
                    </span>
                    <span className="block truncate text-[12px] text-faint">{[v.message || v.commit, v.author, v.branch, v.source].filter(Boolean).join(' · ') || v.id}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
