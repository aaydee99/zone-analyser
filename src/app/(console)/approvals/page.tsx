'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronRight, DatabaseBackup, RotateCcw, ShieldCheck, Undo2, X } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import type { Approval, ApprovalKind, ApprovalStatus } from '@/lib/approvals-store';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader } from '@/components/ui';

const STATUS: Record<ApprovalStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'signal' }> = {
  pending: { label: 'Waiting', tone: 'signal' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'warn' },
  failed: { label: 'Could not start', tone: 'bad' },
};
const KIND: Record<ApprovalKind, { label: string; who: string; icon: typeof DatabaseBackup }> = {
  backup: { label: 'Backup', who: 'an admin or super admin', icon: DatabaseBackup },
  restore: { label: 'Restore apply', who: 'a super admin', icon: RotateCcw },
};

const left = (iso?: string) => {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'expiring';
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'less than a minute left' : `${m} min left`;
};

const link = (a: Approval) => (a.runId ? { href: `/runs/${a.runId}`, label: 'Open the run' } : a.restore && a.status === 'approved' ? { href: `/restore/history/${a.restore.restoreId}`, label: 'Open the restore' } : null);

export default function ApprovalsPage() {
  const toast = useToast();
  const { user, refresh: refreshMe } = useMe();
  const [list, setList] = useState<Approval[] | null>(null);
  const [mayApprove, setMayApprove] = useState<Record<ApprovalKind, boolean>>({ backup: false, restore: false });
  const [busy, setBusy] = useState('');
  const [rejecting, setRejecting] = useState<Approval | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => api<{ approvals: Approval[]; canApprove: Record<ApprovalKind, boolean> }>('/api/approvals')
    .then((r) => { setList(r.approvals); setMayApprove(r.canApprove); }).catch(() => {}), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (a: Approval, what: 'approve' | 'reject' | 'withdraw', body?: object) => {
    setBusy(`${what}:${a.id}`);
    try {
      const r = await api<{ approval: Approval }>(`/api/approvals/${a.id}/${what}`, { method: 'POST', json: body ?? {} });
      const l = link(r.approval);
      toast(what === 'approve' ? (a.kind === 'backup' ? 'Approved — the backup is running' : 'Approved — the restore is applying') : what === 'reject' ? 'Request rejected' : 'Request withdrawn', what === 'approve' ? 'ok' : 'info');
      if (what === 'approve' && l) window.location.assign(l.href);
      await load();
      refreshMe();
    } catch (e) { toast((e as Error).message, 'bad'); await load(); } finally { setBusy(''); }
  };

  const pending = (list ?? []).filter((a) => a.status === 'pending');
  const decided = (list ?? []).filter((a) => a.status !== 'pending');

  return (
    <div className="rise">
      <PageHeader eyebrow="Approvals" title="Approvals"
        description="Operator backups wait for an admin or super admin. Admin restore applies wait for a super admin. Approving starts the backup or the apply at once; every request and decision is in the audit log." />

      <h2 className="mb-3 text-[15px] font-semibold">Waiting {pending.length > 0 && <span className="ml-1 font-mono text-xs text-faint">{pending.length}</span>}</h2>
      {list && !pending.length && (
        <Card className="mb-6"><EmptyState icon={<ShieldCheck className="size-5" />} title="Nothing is waiting" description="Requests to approve appear here, and so do your own requests until someone decides them." /></Card>
      )}
      <div className="mb-8 space-y-4">
        {pending.map((a) => {
          const k = KIND[a.kind];
          const mine = a.requestedBy.id === user.id;
          const canDecide = mayApprove[a.kind] && !mine;
          return (
            <Card key={a.id} className="overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
                <div className="flex min-w-0 gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-signal/30 bg-signal/10 text-signal"><k.icon className="size-5" /></div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><Badge tone="info">{k.label}</Badge><span className="text-[15px] font-semibold break-words">{a.title}</span></div>
                    <p className="mt-0.5 text-xs text-muted">
                      Asked by {mine ? 'you' : a.requestedBy.email} ({a.requestedBy.role.replace('_', ' ')}) · {relTime(a.requestedAt)}
                      {a.expiresAt && <> · <span className="text-warn">{left(a.expiresAt)}</span></>}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {canDecide && <>
                    <Button variant="danger" icon={<X className="size-4" />} disabled={!!busy} onClick={() => { setReason(''); setRejecting(a); }}>Reject</Button>
                    <Button variant="primary" icon={<Check className="size-4" />} loading={busy === `approve:${a.id}`} disabled={!!busy} onClick={() => act(a, 'approve')}>Approve and start</Button>
                  </>}
                  {mine && <Button variant="ghost" icon={<Undo2 className="size-4" />} loading={busy === `withdraw:${a.id}`} disabled={!!busy} onClick={() => act(a, 'withdraw')}>Withdraw</Button>}
                </div>
              </div>
              <ul className="space-y-1 border-t border-line px-5 py-3 text-[13px] text-ink-2">
                {a.details.map((d) => <li key={d}>{d}</li>)}
              </ul>
              {a.restore && a.restore.changes.length > 0 && (
                <details className="border-t border-line px-5 py-3 text-[13px]">
                  <summary className="cursor-pointer text-muted">The {a.restore.changes.length} planned change{a.restore.changes.length === 1 ? '' : 's'}</summary>
                  <ul className="mt-2 space-y-1">
                    {a.restore.changes.map((c) => (
                      <li key={c.address} className="flex flex-wrap items-center gap-2">
                        <Badge tone={c.actions.includes('delete') ? 'bad' : c.actions.includes('create') ? 'ok' : 'info'}>{c.actions.join(' + ')}</Badge>
                        <span className="font-mono text-[12px] break-all">{c.address}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {!canDecide && !mine && <p className="border-t border-line px-5 py-3 text-xs text-muted">Only {k.who} can decide this request.</p>}
              {mine && <p className="border-t border-line px-5 py-3 text-xs text-muted">Waiting for {k.who}. {a.kind === 'backup' ? 'The backup starts as soon as it is approved.' : 'The apply starts as soon as it is approved, while the plan is under 30 minutes old.'}</p>}
            </Card>
          );
        })}
      </div>

      <Card>
        <div className="border-b border-line px-5 py-4"><h2 className="text-[15px] font-semibold">Decided</h2></div>
        {list && !decided.length ? <p className="px-5 py-5 text-[13px] text-muted">No decisions yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-muted">
                  {['Status', 'Request', 'Asked by', 'Decided', ''].map((h) => <th key={h} className="px-5 py-3 text-[11px] font-semibold tracking-[0.1em] uppercase">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {decided.map((a) => {
                  const l = link(a);
                  return (
                    <tr key={a.id} className="group border-b border-line/60 last:border-0 hover:bg-raised/40">
                      <td className="px-5 py-3.5 whitespace-nowrap"><Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge></td>
                      <td className="px-5 py-3.5">
                        <div className="font-medium text-ink">{a.title}</div>
                        <div className="text-[11px] text-faint">{KIND[a.kind].label}{a.reason ? ` · ${a.reason}` : ''}</div>
                      </td>
                      <td className="px-5 py-3.5 text-ink-2" title={fmtDate(a.requestedAt)}>{a.requestedBy.email}<span className="block text-[11px] text-faint">{relTime(a.requestedAt)}</span></td>
                      <td className="px-5 py-3.5 text-ink-2" title={fmtDate(a.decidedAt)}>{a.decidedBy?.email ?? 'the console'}<span className="block text-[11px] text-faint">{relTime(a.decidedAt)}</span></td>
                      <td className="px-3 py-3.5 text-right">{l && <Link href={l.href} className="inline-flex rounded-md p-1.5 text-faint group-hover:text-ink" aria-label={l.label} title={l.label}><ChevronRight className="size-4" /></Link>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={!!rejecting} onClose={() => setRejecting(null)} title="Reject this request?"
        description={rejecting ? `${KIND[rejecting.kind].label} asked by ${rejecting.requestedBy.email}: ${rejecting.title}` : ''}
        footer={<><Button variant="ghost" onClick={() => setRejecting(null)}>Keep it</Button><Button variant="danger" loading={!!rejecting && busy === `reject:${rejecting.id}`} onClick={async () => { const a = rejecting!; await act(a, 'reject', { reason }); setRejecting(null); }}>Reject</Button></>}>
        <Field label="Reason (shown to the requester and kept in the audit log)">
          <input className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
        </Field>
      </Modal>
    </div>
  );
}
