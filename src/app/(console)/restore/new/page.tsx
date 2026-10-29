'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSearch, Lock, Play, RotateCcw, ScanSearch, ShieldAlert, Square } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import type { CredentialOption } from '@/lib/kinds';
import { actorLabel, changeSummary, changeTitle, type CfChange } from '@/lib/cf-audit-report';
import type { CandidateMode } from '@/lib/restore-hcl';
import type { RestoreView, PlannedChange } from '@/lib/restore';
import { Alert, Badge, Button, Card, EmptyState, Field, Modal, PageHeader, SectionHeader, cx } from '@/components/ui';
import { Terminal } from '@/components/terminal';
import { useToast } from '@/components/toast';
import { useMe } from '@/components/me';

interface Zone { id: string; name: string; status: string }

const MODE: Record<CandidateMode, { label: string; tone: 'info' | 'warn' | 'neutral' | 'bad'; help: string }> = {
  revert: { label: 'Revert to backup', tone: 'info', help: 'Still exists — imported, then set back to the backup values.' },
  recreate: { label: 'Re-create', tone: 'warn', help: 'Deleted after the backup — created again from the backup.' },
  'created-after-backup': { label: 'Created after backup', tone: 'neutral', help: 'Not in the backup, so there is nothing to restore it to. Left as it is.' },
  'not-in-backup': { label: 'Not in backup', tone: 'neutral', help: 'The backup has no Terraform block for it (type not exported or account-level). Left as it is.' },
  matches: { label: 'Matches backup', tone: 'neutral', help: 'The live zone already has the backup values.' },
  unchecked: { label: 'Could not check', tone: 'bad', help: 'Terraform could not compare it.' },
  delete: { label: 'Delete (not in backup)', tone: 'bad', help: 'Live now, but the backup does not have it — deleted so the zone matches the backup.' },
};

/** Live value → backup value, as found by "Compare everything". */
function DriftFields({ fields }: { fields: { path: string; old?: string; new?: string }[] }) {
  if (!fields.length) return null;
  return (
    <div className="mt-1.5 overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[380px] text-left text-[11.5px]">
        <thead className="bg-raised/50 text-muted"><tr><th className="w-[30%] px-2.5 py-1 font-medium">Field</th><th className="px-2.5 py-1 font-medium">Live now</th><th className="px-2.5 py-1 font-medium">In backup</th></tr></thead>
        <tbody className="font-mono">
          {fields.slice(0, 12).map((f, i) => (
            <tr key={`${f.path}-${i}`} className="border-t border-line/50 align-top">
              <td className="px-2.5 py-1 break-all text-ink-2">{f.path}</td>
              <td className={cx('px-2.5 py-1 break-all', f.old !== undefined ? 'text-bad/90' : 'text-faint')}>{f.old ?? '—'}</td>
              <td className={cx('px-2.5 py-1 break-all', f.new !== undefined ? 'text-ok' : 'text-faint')}>{f.new ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {fields.length > 12 && <p className="px-2.5 py-1 text-[11px] text-faint">+{fields.length - 12} more field(s) — all shown in the plan</p>}
    </div>
  );
}

const actionLabel = (a: string[]) => (a.includes('delete') && a.includes('create') ? 'replace' : a.includes('create') ? 'create' : a.includes('delete') ? 'delete' : a.includes('update') ? 'update' : 'no change');
const ACTION_TONE: Record<string, 'info' | 'ok' | 'bad' | 'neutral'> = { update: 'info', create: 'ok', replace: 'bad', delete: 'bad', 'no change': 'neutral' };

function PlanFields({ c }: { c: PlannedChange }) {
  if (!c.fields.length) return null;
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[420px] text-left text-[12px]">
        <thead className="bg-raised/50 text-muted">
          <tr><th className="w-[30%] px-3 py-1.5 font-medium">Field</th><th className="px-3 py-1.5 font-medium">Live now</th><th className="px-3 py-1.5 font-medium">After restore (backup)</th></tr>
        </thead>
        <tbody className="font-mono">
          {c.fields.slice(0, 30).map((f, i) => (
            <tr key={`${f.path}-${i}`} className="border-t border-line/50 align-top">
              <td className="px-3 py-1.5 break-all text-ink-2">{f.path}</td>
              <td className={cx('px-3 py-1.5 break-all', f.old !== undefined ? 'text-bad/90' : 'text-faint')}>{f.old ?? '—'}</td>
              <td className={cx('px-3 py-1.5 break-all', f.new !== undefined ? 'text-ok' : 'text-faint')}>{f.new ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RestorePage() {
  const toast = useToast();
  const { can, activeRunId, activeRestore, refresh: refreshMe } = useMe();
  const allowed = can('restore:run');
  const [creds, setCreds] = useState<CredentialOption[]>([]);
  const [cfId, setCfId] = useState('');
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [zoneId, setZoneId] = useState('');
  const [kind, setKind] = useState<'r2' | 'aws'>('r2');
  const [bucket, setBucket] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [r, setR] = useState<RestoreView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  // Asked for at every apply and sent with that request only; cleared right after.
  const [keyEmail, setKeyEmail] = useState('');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    if (!allowed) return;
    api<{ options: CredentialOption[] }>('/api/credentials/options').then(({ options }) => {
      setCreds(options);
      setCfId((x) => x || options.find((o) => o.kind === 'cloudflare')?.id || '');
    }).catch((e) => toast((e as Error).message, 'bad'));
  }, [allowed, toast]);

  useEffect(() => {
    if (!cfId) return;
    setZones(null);
    api<{ zones: Zone[] }>(`/api/zones?credentialId=${encodeURIComponent(cfId)}`)
      .then((x) => { setZones(x.zones); setZoneId((z) => (x.zones.some((y) => y.id === z) ? z : '')); })
      .catch((e) => { setZones([]); toast((e as Error).message, 'bad'); });
  }, [cfId, toast]);

  // After a refresh: show the restore that is running (or the one this tab had open), not a blank page.
  const reattached = useRef(false);
  useEffect(() => {
    if (!allowed || reattached.current) return;
    reattached.current = true;
    let saved: string | null = null;
    try { saved = sessionStorage.getItem('restore.session'); } catch { /* storage blocked */ }
    const id = activeRestore?.id ?? saved;
    if (id) api<RestoreView>(`/api/restore/${id}`).then((v) => {
      // The pickers show the session's own account set, zone and bucket again.
      setR(v); setCfId(v.account.credentialId); setZoneId(v.zone.id); setKind(v.source.kind); setBucket(v.source.bucket);
    }).catch(() => { try { sessionStorage.removeItem('restore.session'); } catch { /* storage blocked */ } });
  }, [allowed, activeRestore]);
  useEffect(() => {
    try { if (r?.id) sessionStorage.setItem('restore.session', r.id); } catch { /* storage blocked */ }
  }, [r?.id]);

  // Only one job runs at a time: a backup, or another restore, blocks every step here.
  const otherJob = activeRunId ? { text: 'A backup is running', href: `/runs/${activeRunId}`, link: 'View the backup' }
    : activeRestore && activeRestore.id !== r?.id ? { text: `A restore of ${activeRestore.zone} is running (${activeRestore.job}, by ${activeRestore.by})`, href: '/restore/new', link: '' }
    : null;
  const lockedOut = !!otherJob;

  // Poll while Terraform runs.
  const running = r?.state === 'planning' || r?.state === 'applying' || r?.state === 'scanning';
  useEffect(() => {
    if (!r || !(running || r.approval)) return;
    const t = setInterval(() => { api<RestoreView>(`/api/restore/${r.id}`).then(setR).catch(() => {}); }, 1500);
    return () => clearInterval(t);
  }, [r, running]);

  // Cancelling the running job (compare, plan or apply).
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const jobName = r?.state === 'applying' ? 'apply' : r?.state === 'planning' ? 'plan' : 'comparison';
  const cancelJob = async () => {
    if (!r) return;
    setCancelling(true);
    try { setR(await api<RestoreView>(`/api/restore/${r.id}/cancel`, { method: 'POST' })); toast(`Cancelling the ${jobName}…`, 'info'); }
    catch (e) { toast((e as Error).message, 'bad'); } finally { setCancelling(false); setCancelOpen(false); }
  };
  useEffect(() => { if (!running) refreshMe(); }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const planFor = useCallback(async (id: string, addresses: string[]) => {
    setBusy(true); setConfirm(''); setAck(false); setApiKey('');
    try { setR(await api<RestoreView>(`/api/restore/${id}/plan`, { method: 'POST', json: { addresses } })); refreshMe(); }
    catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  }, [toast, refreshMe]);

  // When a comparison finishes, select what it found (once per comparison).
  const seenScan = useRef('');
  useEffect(() => {
    if (r?.state === 'scanned' && r.scan && seenScan.current !== r.scan.at) { seenScan.current = r.scan.at; setSelected(new Set(r.selected)); }
  }, [r]);

  // A plan with changes is ready: bring the apply step (email + Global API Key) into view.
  const seenPlan = useRef('');
  useEffect(() => {
    if (r?.state !== 'planned' || !r.plan || r.plan.noChanges || seenPlan.current === r.plan.at) return;
    seenPlan.current = r.plan.at;
    document.getElementById('restore-apply')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [r]);

  // Backups are read only from the chosen account set's own storage.
  const storage = creds.find((c) => c.id === cfId)?.storage ?? {};
  const buckets = storage[kind] ?? [];
  useEffect(() => {
    // The set has no storage of the selected kind: switch to the one it has.
    if (!storage[kind] && (storage.r2 || storage.aws)) { setKind(storage.r2 ? 'r2' : 'aws'); setBucket(''); }
  }, [storage, kind]);
  const changesById = useMemo(() => new Map((r?.changes ?? []).map((c) => [c.id, c])), [r]);

  const prepare = useCallback(async () => {
    setBusy(true); setError(''); setR(null); setConfirm(''); setAck(false);
    try {
      const v = await api<RestoreView>('/api/restore', { method: 'POST', json: { cloudflareCredentialId: cfId, zoneId, storage: { kind, bucket } } });
      setR(v);
      setSelected(new Set());
      // Every time: compare the live zone with the backup now (fresh import), so anything already
      // restored shows as matching instead of being offered again from the audit log.
      try { setR(await api<RestoreView>(`/api/restore/${v.id}/compare`, { method: 'POST' })); refreshMe(); }
      catch (e) { toast((e as Error).message, 'bad'); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [cfId, zoneId, kind, bucket, toast, refreshMe]);

  const plan = () => { if (r) void planFor(r.id, [...selected]); };
  const compare = async () => {
    if (!r) return;
    setBusy(true); setConfirm(''); setAck(false); setApiKey('');
    try { setR(await api<RestoreView>(`/api/restore/${r.id}/compare`, { method: 'POST' })); refreshMe(); }
    catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  // Admins ask a super admin to approve the apply; super admins apply directly.
  const needsApproval = !can('restore:approve');
  const apply = async () => {
    if (!r) return;
    setBusy(true);
    try {
      const v = await api<RestoreView>(`/api/restore/${r.id}/apply`, { method: 'POST', json: { confirm, acknowledgeReplace: ack, email: keyEmail, apiKey } });
      setR(v);
      if (v.approval) toast('Sent for approval — the apply starts when a super admin approves it', 'info');
      refreshMe();
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); setApiKey(''); }
  };
  const [withdrawing, setWithdrawing] = useState(false);
  const withdrawApply = async () => {
    if (!r?.approval) return;
    setWithdrawing(true);
    try { await api(`/api/approvals/${r.approval.id}/withdraw`, { method: 'POST' }); setR(await api<RestoreView>(`/api/restore/${r.id}`)); toast('Request withdrawn', 'info'); }
    catch (e) { toast((e as Error).message, 'bad'); } finally { setWithdrawing(false); }
  };

  if (!allowed) {
    return <Card className="rise mx-auto mt-6 max-w-lg"><EmptyState icon={<Lock className="size-5" />} title="Admins only" description="Restoring changes live Cloudflare configuration, so it is limited to admins and super admins." /></Card>;
  }

  const blockedOf = (c: { mode: string; importId?: string }) => (c.mode === 'revert' || c.mode === 'delete') && !c.importId;
  // Only what can be restored is shown: items that cannot be checked or imported are left out.
  const restorable = r?.candidates.filter((c) => (c.mode === 'revert' || c.mode === 'recreate' || c.mode === 'delete') && !blockedOf(c)) ?? [];
  const selectable = restorable.filter((c) => !blockedOf(c));
  const matching = r?.candidates.filter((c) => c.mode === 'matches') ?? [];
  const planChanges = r?.plan?.changes.filter((c) => !c.actions.includes('no-op')) ?? [];
  const planAgeMin = r?.plan ? Math.floor((Date.now() - Date.parse(r.plan.at)) / 60_000) : 0;
  const titles = (ids: string[]) => ids.map((id) => changesById.get(id)).filter((c): c is CfChange => !!c);

  return (
    <div className="rise space-y-6">
      <PageHeader eyebrow="Restore" title="New restore"
        description="Put a zone back exactly as its latest backup has it. Each check imports the live zone fresh and compares every resource with the backup in the bucket; Terraform plans the difference, you review, then apply." />

      {otherJob && (
        <Alert tone="warn" title={otherJob.text}>
          Only one job runs at a time — restoring is paused until it finishes.{otherJob.link && <> <Link href={otherJob.href} className="font-medium text-signal hover:underline">{otherJob.link}</Link></>}
        </Alert>
      )}

      {/* 1 — Source */}
      <Card>
        <SectionHeader step="01" title="Zone and backup" description="The newest backup folder in the bucket that contains this zone is used." />
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <Field label="Account set" hint="Its token reads the zone and makes the plan (read-only is enough); its own buckets hold the backups. Applying asks for a Global API Key and email each time.">
            <select className="input" value={cfId} onChange={(e) => { setCfId(e.target.value); setBucket(''); setR(null); }}>
              {creds.filter((c) => c.kind === 'cloudflare').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Zone">
            <select className="input" value={zoneId} onChange={(e) => { setZoneId(e.target.value); setR(null); }} disabled={!zones}>
              <option value="">{zones ? 'Choose a zone…' : 'Loading zones…'}</option>
              {zones?.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </Field>
          <Field label="Backups are in">
            <div className="flex gap-2">
              {(['r2', 'aws'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} disabled={!storage[k]} title={storage[k] ? undefined : 'This account set has no such storage'}
                  onClick={() => { setKind(k); setBucket(''); setR(null); }}
                  className={cx('rounded-lg border px-3 py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-40', kind === k && storage[k] ? 'border-signal/60 bg-signal/10 text-ink' : 'border-line text-muted hover:text-ink-2')}>
                  {k === 'r2' ? 'Cloudflare R2' : 'AWS S3'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Bucket" hint={buckets.length ? 'Only this account set’s approved buckets.' : undefined}>
            {buckets.length ? (
              <select id="restore-bucket" className="input font-mono !text-[13px]" value={bucket || buckets[0]} onChange={(e) => { setBucket(e.target.value === buckets[0] ? '' : e.target.value); setR(null); }}>
                {buckets.map((b, i) => <option key={b} value={b}>{b}{i === 0 ? ' (default)' : ''}</option>)}
              </select>
            ) : <p className="py-2 text-[13px] text-muted">{cfId ? 'This account set has no R2 or S3 storage — a super admin can add it in the vault.' : 'Choose an account set.'}</p>}
          </Field>
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-3">
          {error && <span className="mr-auto text-[13px] text-bad">{error}</span>}
          <Button variant="primary" icon={<FileSearch className="size-4" />} loading={busy && !r} disabled={!cfId || !zoneId || !buckets.length || lockedOut || running} onClick={prepare}>Find latest backup &amp; compare</Button>
        </div>
      </Card>

      {r && (
        <>
          {/* 2 — What changed */}
          <Card>
            <SectionHeader step="02" title="Live zone vs the backup" description={`${r.zone.name} · checked against the live zone${r.scan ? ` at ${fmtDate(r.scan.at)}` : ''}`} />
            <div className="space-y-4 p-5">
              <div className="grid gap-3 text-[13px] sm:grid-cols-3">
                <div><div className="text-muted">Backup used</div><div className="mt-0.5 font-mono text-xs break-all">{r.source.bucket}/{r.source.folder}/{r.zone.name}/</div></div>
                <div><div className="text-muted">Taken</div><div className="mt-0.5">{fmtDate(r.source.backupTime)} <span className="text-faint">({relTime(r.source.backupTime)})</span></div></div>
                <div><div className="text-muted">Audit-log changes since</div><div className="mt-0.5">{r.changes.length} <span className="text-faint">(creates, updates, deletes)</span>{r.auditTruncated ? ' — audit log cut at its limit' : ''}</div>{r.ignored > 0 && (
                  <details className="mt-0.5 text-xs text-faint">
                    <summary className="cursor-pointer">{r.ignored} read or non-config entr{r.ignored === 1 ? 'y' : 'ies'} ignored (cache purges, exports — views, reads and failed requests are filtered out by Cloudflare)</summary>
                    <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto font-mono break-all">
                      {r.ignoredEntries.map((e) => <li key={e.id}>{fmtDate(e.time)} {e.method || '—'} {e.uri} {e.actionType ? `(${e.actionType})` : ''}{e.result === 'failure' ? ' failed' : ''}</li>)}
                    </ul>
                  </details>
                )}</div>
              </div>
              {r.source.skippedNewer.length > 0 && (
                <Alert tone="warn" title="Newer backups skipped">{r.source.skippedNewer.length} newer folder(s), newest {r.source.newestFolder}, do not contain {r.zone.name}, so the newest backup that does was used.</Alert>
              )}
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-signal/30 bg-signal/[0.04] px-4 py-3">
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="font-medium">Compared with the live zone{r.scan && r.state !== 'scanning' ? ` · ${relTime(r.scan.at)}` : ''}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    Every one of the <b>{r.blockCount}</b> resource(s) in the backup — DNS records, settings, rules, rulesets — is imported fresh from the live zone and compared,
                    and the live zone is listed for anything added since. What you already restored shows as matching. Read-only; it can take a few minutes.
                  </p>
                </div>
                <Button variant="secondary" icon={<ScanSearch className="size-4" />} loading={r.state === 'scanning'} disabled={running || busy || lockedOut || r.state === 'applied' || r.state === 'matched' || !!r.approval} onClick={compare}>
                  Compare again
                </Button>
              </div>
              {(r.state === 'scanning' || (busy && !r.scan)) && <p className="text-[13px] text-muted">Importing the live zone and comparing it with the backup… (progress in the log below)</p>}
              {r.scan && !r.scan.error && r.state !== 'scanning' && (
                <div className="grid gap-2 text-[13px] sm:grid-cols-4">
                  <div className="rounded-lg border border-line px-3 py-2"><div className="text-xs text-muted">Differ from backup</div><div className="text-lg font-semibold text-info">{r.scan.differs}</div></div>
                  <div className="rounded-lg border border-line px-3 py-2"><div className="text-xs text-muted">Deleted (re-create)</div><div className="text-lg font-semibold text-warn">{r.scan.missing}</div></div>
                  <div className="rounded-lg border border-line px-3 py-2"><div className="text-xs text-muted">Not in backup (delete)</div><div className="text-lg font-semibold text-bad">{r.scan.extra}</div></div>
                  <div className="rounded-lg border border-line px-3 py-2"><div className="text-xs text-muted">Match the backup</div><div className="text-lg font-semibold">{r.scan.matches}</div></div>
                </div>
              )}
              {r.scan?.error && r.state !== 'scanning' && <Alert tone="bad" title="The comparison failed">{r.scan.error}. Nothing was changed — see the log below.</Alert>}
              {!r.scan || r.state === 'scanning' || r.scan.error ? null : r.state === 'matched' ? (
                <EmptyState icon={<CheckCircle2 className="size-5" />} title="The live zone matches the backup: restore complete"
                  description={`All ${r.scan.matches} resource(s) are as backed up and nothing was added since, so there was nothing to restore and nothing was changed. This restore is closed; choose a zone and backup above to start another.`} />
              ) : !restorable.length ? (
                <EmptyState icon={<CheckCircle2 className="size-5" />} title="Nothing to restore" description={`${r.scan.matches} resource(s) match the backup, but ${r.scan.unchecked} could not be checked${r.scan.listFailed.length ? ` and ${r.scan.listFailed.length} resource type(s) could not be listed` : ''}, so the restore stays open. See the log below, then compare again.`} />
              ) : (
                <>
                  <ul className="divide-y divide-line/60 rounded-xl border border-line">
                    {restorable.map((c) => {
                      const meta = MODE[c.mode];
                      const blocked = blockedOf(c);
                      return (
                        <li key={c.key} className="flex gap-3 px-4 py-3">
                          <input type="checkbox" className="mt-1 size-4 accent-[var(--color-signal)]" aria-label={`Restore ${c.address}`} disabled={blocked || running}
                            checked={selected.has(c.key)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(c.key); else n.delete(c.key); return n; })} />
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 text-[13px]">
                              <span className="font-mono break-all">{c.address}</span>
                              <Badge tone={meta.tone}>{meta.label}</Badge>
                              {blocked && <Badge tone="bad">cannot import</Badge>}
                            </p>
                            <p className="mt-0.5 text-xs text-muted">
                              {blocked ? `Import not possible: ${c.importSkip}`
                                : c.recreatedAs ? `Deleted after the backup and created again (ID ${c.recreatedAs}) — that object is imported and set back to the backup values, not duplicated.`
                                  : c.mode === 'delete' ? (c.typeInBackup ? meta.help : 'Live now, and the backup has no resources of this type at all (maybe it could not be exported) — not selected; tick it to delete it anyway.')
                                  : c.found === 'compare' && c.mode === 'recreate' ? 'Not found in the live zone — it will be created again from the backup.'
                                    : c.found === 'compare' ? 'Differs from the backup in the live zone — imported, then set back to the backup values.'
                                      : meta.help}
                              {c.found === 'compare' && !c.changeIds.length && <span className="text-faint"> · found by comparison (not in the audit log)</span>}
                              {c.mode === 'delete' && blocked && <span className="text-bad"> · cannot be deleted by Terraform: {c.importSkip}</span>}
                            </p>
                            {c.drift && <DriftFields fields={c.drift} />}
                            <ul className="mt-1.5 space-y-1 text-xs">
                              {titles(c.changeIds).map((ch) => (
                                <li key={ch.id} className="text-ink-2">
                                  <span className="font-mono text-faint">{fmtDate(ch.time)}</span> {changeTitle(ch)}{ch.changes.length ? <span className="text-muted"> — {changeSummary(ch, 2)}</span> : null} <span className="text-faint">· {actorLabel(ch)}</span>
                                </li>
                              ))}
                            </ul>
                            {c.blockText && (
                              <details className="mt-1.5"><summary className="cursor-pointer text-xs text-faint hover:text-ink-2">Backup block</summary>
                                <pre className="mt-1 max-h-56 overflow-auto rounded-lg border border-line bg-canvas p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{c.blockText}</pre>
                              </details>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {matching.length > 0 && (
                    <details className="rounded-xl border border-line px-4 py-3">
                      <summary className="cursor-pointer text-[13px] text-muted">{matching.length} resource(s) already match the backup</summary>
                      <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto font-mono text-xs text-ink-2">
                        {matching.map((c) => <li key={c.key} className="break-all">{c.address}</li>)}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </div>
            {restorable.length > 0 && r.scan && r.state !== 'scanning' && (
              <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-3">
                <span className="mr-auto text-xs text-muted">{selected.size} of {restorable.length} selected · only these blocks go into the Terraform plan</span>
                {restorable.length > 1 && (
                  <Button variant="ghost" size="sm" disabled={running} onClick={() => setSelected(selected.size === selectable.length ? new Set() : new Set(selectable.map((c) => c.key)))}>
                    {selected.size === selectable.length ? 'Select none' : 'Select all'}
                  </Button>
                )}
                <Button variant="primary" icon={<RotateCcw className="size-4" />} loading={busy && r.state !== 'planned'} disabled={!selected.size || running || lockedOut || r.state === 'applied' || r.state === 'matched' || !!r.approval} onClick={plan}>
                  {r.plan ? 'Plan again' : 'Plan restore'}
                </Button>
              </div>
            )}
          </Card>

            {r.cancelled && r.cancelled.job !== 'applying' && !running && (r.state === 'prepared' || (r.state === 'scanned' && !r.plan)) && (
              <Alert tone="info" title={r.cancelled.job === 'planning' ? 'Planning cancelled' : 'Comparison cancelled'}>Cancelled by {r.cancelled.by} — nothing was changed. {r.cancelled.job === 'planning' ? 'Choose what to restore and plan again.' : 'Compare again when you are ready.'}</Alert>
            )}
          {/* 3 — Plan & apply */}
          {r.state !== 'prepared' && (
            <Card>
              <SectionHeader step="03" title="Plan and apply" description="terraform plan against the live zone. Nothing changes until you apply." />
              <div className="space-y-4 p-5">
                {r.state === 'planning' && <p className="text-[13px] text-muted">Running terraform init and plan…</p>}
                {r.state === 'plan-failed' && <Alert tone="bad" title="Plan failed">See the Terraform output below. Nothing was changed.</Alert>}
                {r.plan && (
                  <>
                    {r.plan.noChanges ? (
                      <Alert tone="ok" title="Nothing to apply">The live zone already matches the backup for the selected resources.</Alert>
                    ) : (
                      <ul className="divide-y divide-line/60 rounded-xl border border-line">
                        {planChanges.map((c) => {
                          const a = actionLabel(c.actions);
                          return (
                            <li key={c.address} className="px-4 py-3">
                              <p className="flex flex-wrap items-center gap-2 text-[13px]">
                                <Badge tone={ACTION_TONE[a]}>{a}</Badge>
                                <span className="font-mono break-all">{c.address}</span>
                                {c.importing && <Badge>import</Badge>}
                                {c.api && <Badge>via API</Badge>}
                                {c.dependency && <Badge tone="warn">referenced by a chosen block</Badge>}
                              </p>
                              <PlanFields c={c} />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {!r.plan.noChanges && r.plan.changes.length > planChanges.length && (
                      <p className="text-xs text-muted">{r.plan.changes.length - planChanges.length} selected resource(s) already match the backup — Terraform leaves them as they are.</p>
                    )}
                    {(r.plan.hasReplace || r.plan.hasDelete) && (
                      <Alert tone="bad" title="This plan replaces or deletes resources">Replace means Terraform deletes the live object and creates it again from the backup. Check the list above.</Alert>
                    )}
                    {r.state === 'planned' && r.approval && (
                      <div id="restore-approval" className="rounded-xl border border-signal/30 bg-signal/[0.05] p-4">
                        <p className="flex items-center gap-2 text-[13px] font-medium"><span className="live-dot size-2 rounded-full bg-live" /> Waiting for a super admin to approve the apply</p>
                        <p className="mt-1 text-xs text-muted">
                          Asked by {r.approval.requestedBy} {relTime(r.approval.requestedAt)}. The apply starts as soon as it is approved — until {fmtDate(r.approval.expiresAt)}, when the plan gets too old.
                          The Global API Key is held in the console&apos;s memory only until then. <Link href="/approvals" className="text-signal hover:underline">Approvals</Link>
                        </p>
                        <Button className="mt-3" variant="ghost" size="sm" loading={withdrawing} onClick={withdrawApply}>Withdraw the request</Button>
                      </div>
                    )}
                    {r.state === 'planned' && !r.plan.noChanges && !r.approval && (
                      <div id="restore-apply" className="rounded-xl border border-warn/30 bg-warn/[0.05] p-4">
                        <p className="flex items-center gap-2 text-[13px] font-medium"><ShieldAlert className="size-4 text-warn" /> Apply this plan to {r.zone.name}?</p>
                        <p className="mt-1 text-xs text-muted">Applies exactly the plan above (made {planAgeMin} min ago; plans expire after 30 min).</p>
                        <div className="mt-3 flex flex-wrap items-end gap-3">
                          <label className="grid gap-1 text-xs text-muted">
                            <span>Type <span className="font-mono text-ink-2">{r.zone.name}</span> to confirm</span>
                            <input id="restore-confirm" className="input !w-72 font-mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
                          </label>
                          <label className="grid gap-1 text-xs text-muted">
                            <span>Cloudflare account email</span>
                            <input id="restore-key-email" type="email" className="input !w-64" value={keyEmail} onChange={(e) => setKeyEmail(e.target.value)} placeholder="you@company.com" autoComplete="off" spellCheck={false} />
                          </label>
                          <label className="grid gap-1 text-xs text-muted">
                            <span>Global API Key</span>
                            <input id="restore-api-key" type="password" className="input !w-72 font-mono" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="My Profile › API Tokens › Global API Key" autoComplete="new-password" spellCheck={false} data-1p-ignore data-lpignore="true" />
                          </label>
                          {(r.plan.hasReplace || r.plan.hasDelete) && (
                            <label className="flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand resources will be replaced or deleted</label>
                          )}
                          <Button variant="primary" icon={<Play className="size-4" />} loading={busy}
                            disabled={lockedOut || confirm.trim().toLowerCase() !== r.zone.name.toLowerCase() || !keyEmail.trim() || !apiKey.trim() || ((r.plan.hasReplace || r.plan.hasDelete) && !ack)} onClick={apply}>{needsApproval ? 'Ask a super admin to apply' : 'Apply'}</Button>
                        </div>
                        {needsApproval && <p className="mt-2 text-xs text-warn">A super admin approves every restore an admin applies. Your key is checked now and held in memory only until they decide; the apply starts the moment it is approved.</p>}
                        <p className="mt-2 text-xs text-faint">The plan was made with the stored API token. Applying needs the Global API Key of a user who can edit {r.zone.name} — asked for every apply, checked with Cloudflare, used for this apply only and never stored or logged.</p>
                      </div>
                    )}
                  </>
                )}
                {r.state === 'scanning' && <p className="text-[13px] text-muted">Comparing every resource in the backup with the live zone…</p>}
                {r.state === 'scanned' && !r.plan && <p className="text-[13px] text-muted">Comparison finished. {restorable.length ? <>Choose what to restore above, then <b>Plan restore</b>.</> : 'Nothing to restore.'}</p>}
                {r.state === 'applying' && <p className="text-[13px] text-muted">Applying…</p>}
                {r.state === 'applied' && (
                  <Alert tone={r.verified ? 'ok' : 'warn'} title={r.verified ? 'Restored and verified' : 'Applied — check needs attention'}>
                    {r.verified ? `Applied ${fmtDate(r.appliedAt ?? '')}. A new plan shows the restored resources now match the backup.` : 'Terraform applied the plan, but a follow-up plan still shows differences. See the output below.'}
                  </Alert>
                )}
                {r.state === 'apply-failed' && (r.cancelled?.job === 'applying'
                  ? <Alert tone="warn" title="Apply cancelled">Cancelled by {r.cancelled.by}. Changes Terraform had already sent to Cloudflare stay; plan again to see what is left to restore.</Alert>
                  : <Alert tone="bad" title="Apply failed">See the Terraform output below. Some changes may have been applied; plan again to see the current difference.</Alert>)}
                {r.state === 'matched' && (
                  <Alert tone="ok" title="Restore complete">{r.plan?.noChanges ? 'Terraform found nothing to change: the live zone already matches the backup.' : 'The comparison found the live zone matches the backup.'} Nothing was applied, and this restore is closed.</Alert>
                )}
                {(r.state === 'applied' || r.state === 'apply-failed' || r.state === 'matched') && (
                  <Link href={`/restore/history/${r.id}`} className="inline-flex items-center gap-1.5 text-[13px] text-signal hover:underline">This restore in Restore history →</Link>
                )}
                {r.log.length > 0 && <Terminal lines={r.log} live={running} filename={`restore-${r.zone.name}.log`} />}
                {running && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="danger" size="sm" icon={<Square className="size-3.5" />} loading={cancelling} disabled={cancelling || r.log.some((l) => l.startsWith('[CANCELLED]'))} onClick={() => setCancelOpen(true)}>Cancel {jobName}</Button>
                    <p className="flex items-center gap-2 text-xs text-faint"><AlertTriangle className="size-3.5" /> Keep this page open, or come back to it — the job keeps running on the server.</p>
                  </div>
                )}
              </div>
            </Card>
          )}
        </>
      )}
      <Modal
        open={cancelOpen} onClose={() => setCancelOpen(false)} title={`Cancel the ${jobName}?`}
        description="terraform and the Cloudflare provider are stopped, and no further step starts."
        footer={<><Button variant="ghost" onClick={() => setCancelOpen(false)}>Keep running</Button><Button variant="danger" loading={cancelling} onClick={cancelJob}>Cancel {jobName}</Button></>}
      >
        <p className="text-sm text-muted">
          {r?.state === 'applying'
            ? <>Applying is <span className="text-warn">not undone</span>: changes Terraform has already sent to Cloudflare stay. Plan again afterwards to see what is left to restore.</>
            : r?.state === 'planning' ? 'Nothing has been changed yet — planning only reads. You can plan again afterwards.' : 'Nothing has been changed — comparing only reads. You can compare again afterwards.'}
        </p>
      </Modal>
    </div>
  );
}
