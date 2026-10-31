import 'server-only';
import { audit } from './audit';
import type { Me } from './auth';
import type { BackupConfig } from './config';
import { HttpError } from './http';
import { can, type Permission } from './rbac';
import { ApprovalGone, approveRestoreApply, dropRestoreApproval } from './restore';
import { checkRunConfig, startRun } from './runner';
import { executeAction } from './cf-actions';
import { listApprovals, newApproval, readApproval, saveApproval, type Approval, type ApprovalKind } from './approvals-store';

// Who approves what: an operator's backup needs an admin or super admin; an admin's restore apply needs
// a super admin. Approving starts it at once. Every request and decision goes to the audit log.

/** The permission that lets someone approve (and skip approval for) each kind of request. */
export const APPROVER: Record<ApprovalKind, Permission> = { backup: 'runs:approve', restore: 'restore:approve', cloudflare: 'restore:approve' };
export const canApprove = (me: Pick<Me, 'role'>, kind: ApprovalKind) => can(me.role, APPROVER[kind]);

const yesNo = (b: boolean) => (b ? 'yes' : 'no');

/** An operator asks for a backup: checked like a start, then waits for an admin or super admin. */
export async function requestBackup(me: Me, config: BackupConfig, presetName?: string): Promise<Approval> {
  const checked = await checkRunConfig(config);
  const zones = config.zoneMode === 'all' ? 'all zones' : `${config.zoneIds.length} zone${config.zoneIds.length === 1 ? '' : 's'}`;
  const a = newApproval({
    kind: 'backup', requestedBy: { id: me.id, email: me.email, role: me.role },
    title: `Backup ${presetName ? `“${presetName}”` : checked.cloudflare} · ${zones}`,
    details: [
      `Account ${checked.cloudflare}${config.accountId ? ` › ${config.accountId}` : ''} · ${zones}${config.nameFilter.trim() ? ` matching ${config.nameFilter.trim()}` : ''}`,
      `Mode ${config.importMode ? 'generate + import' : 'generate only'} · account resources ${config.accountScope}${config.withAccount ? ' (with account)' : ''}`,
      `Upload: R2 ${config.r2.enabled ? checked.r2Bucket : 'off'} · S3 ${config.aws.enabled ? checked.awsBucket : 'off'}`,
      `Output folder ${checked.outputDir} · audit log ${config.auditLogHours} h · import mode ${yesNo(config.importMode)}`,
    ],
    backup: { config, ...(presetName ? { presetName } : {}) },
  });
  await audit(me, 'approval.requested', a.title, { approvalId: a.id, kind: 'backup', preset: presetName ?? null, cloudflare: checked.cloudflare });
  return a;
}

/** Restore requests whose plan is past its age limit expire (and their held key is dropped). */
function expireStale(list: Approval[]): Approval[] {
  const now = Date.now();
  for (const a of list) {
    if (a.status === 'pending' && a.expiresAt && Date.parse(a.expiresAt) < now) {
      Object.assign(a, { status: 'expired', decidedAt: new Date().toISOString(), reason: 'The plan got older than 30 minutes before anyone approved it' });
      saveApproval(a);
      if (a.kind === 'restore') dropRestoreApproval(a, 'Apply request expired — the plan is older than 30 minutes', 'console');
      void audit(null, 'approval.expired', a.title, { approvalId: a.id, kind: a.kind, requestedBy: a.requestedBy.email });
    }
  }
  return list;
}

/** Requests someone may see: approvers see the kinds they approve; everyone sees their own. */
export function approvalsFor(me: Me): Approval[] {
  return expireStale(listApprovals()).filter((a) => canApprove(me, a.kind) || a.requestedBy.id === me.id);
}

export function approvalFor(me: Me, id: string): Approval {
  const a = readApproval(id);
  if (!a || !(canApprove(me, a.kind) || a.requestedBy.id === me.id)) throw new HttpError(404, 'Request not found');
  return expireStale([a])[0];
}

const deciding = new Set<string>();

/** Approve (starts it now) or reject a pending request. Nobody decides their own request. */
export async function decide(me: Me, id: string, decision: 'approve' | 'reject', reason = ''): Promise<Approval> {
  const a = approvalFor(me, id);
  if (!canApprove(me, a.kind)) throw new HttpError(403, a.kind === 'backup' ? 'Only an admin or super admin approves backups' : a.kind === 'restore' ? 'Only a super admin approves restores' : 'Only a super admin approves Cloudflare changes');
  if (a.requestedBy.id === me.id) throw new HttpError(403, 'You cannot decide your own request');
  if (a.status !== 'pending') throw new HttpError(409, `This request is already ${a.status}`);
  if (deciding.has(id)) throw new HttpError(409, 'This request is being decided right now');
  deciding.add(id);
  try {
    const note = reason.trim().slice(0, 500);
    const decided = { decidedBy: { email: me.email, role: me.role }, decidedAt: new Date().toISOString() };
    if (decision === 'reject') {
      Object.assign(a, { status: 'rejected', ...decided, ...(note ? { reason: note } : {}) });
      saveApproval(a);
      if (a.kind === 'restore') dropRestoreApproval(a, `Apply request rejected by ${me.email}${note ? `: ${note}` : ''}`, me.email);
      await audit(me, 'approval.rejected', a.title, { approvalId: a.id, kind: a.kind, requestedBy: a.requestedBy.email, reason: note || null });
      return a;
    }
    try {
      if (a.kind === 'backup') {
        const requester: Me = { id: a.requestedBy.id, email: a.requestedBy.email, name: '', role: a.requestedBy.role, sessionHash: '', expiresAt: 0 };
        const run = await startRun(requester, a.backup!.config, a.backup!.presetName, { id: a.id, by: me.email });
        a.runId = run.id;
      } else if (a.kind === 'cloudflare') {
        a.result = await executeAction(a.action!);
      } else {
        await approveRestoreApply(me, a);
      }
    } catch (err) {
      // Busy (a backup or restore is running): stays pending, approve again when it finishes.
      if (err instanceof HttpError && err.status === 409) throw err;
      const message = err instanceof Error ? err.message : String(err);
      Object.assign(a, { status: err instanceof ApprovalGone ? 'expired' : 'failed', ...decided, reason: message });
      saveApproval(a);
      if (a.kind === 'restore') dropRestoreApproval(a, `Apply request could not start: ${message}`, me.email);
      await audit(me, 'approval.failed', a.title, { approvalId: a.id, kind: a.kind, requestedBy: a.requestedBy.email, error: message });
      throw err instanceof HttpError ? err : new HttpError(422, `Approved, but it could not start: ${message}`);
    }
    Object.assign(a, { status: 'approved', ...decided });
    saveApproval(a);
    await audit(me, 'approval.approved', a.title, { approvalId: a.id, kind: a.kind, requestedBy: a.requestedBy.email, ...(a.runId ? { runId: a.runId } : {}), ...(a.restore ? { restoreId: a.restore.restoreId } : {}) });
    return a;
  } finally {
    deciding.delete(id);
  }
}

/** The requester takes a pending request back. */
export async function withdraw(me: Me, id: string): Promise<Approval> {
  const a = approvalFor(me, id);
  if (a.requestedBy.id !== me.id) throw new HttpError(403, 'Only the person who asked can withdraw a request');
  if (a.status !== 'pending') throw new HttpError(409, `This request is already ${a.status}`);
  if (deciding.has(id)) throw new HttpError(409, 'This request is being decided right now');
  Object.assign(a, { status: 'withdrawn', decidedBy: { email: me.email, role: me.role }, decidedAt: new Date().toISOString() });
  saveApproval(a);
  if (a.kind === 'restore') dropRestoreApproval(a, 'Apply request withdrawn', me.email);
  await audit(me, 'approval.withdrawn', a.title, { approvalId: a.id, kind: a.kind });
  return a;
}

/** Pending requests this person can decide (for the sidebar badge). */
export const pendingFor = (me: Me) => approvalsFor(me).filter((a) => a.status === 'pending' && canApprove(me, a.kind) && a.requestedBy.id !== me.id).length;
