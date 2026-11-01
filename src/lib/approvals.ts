import 'server-only';
import { audit } from './audit';
import type { Me } from './auth';
import type { BackupConfig } from './config';
import { HttpError } from './http';
import { can, type Permission } from './rbac';
import { ApprovalGone, approveRestoreApply, dropRestoreApproval } from './restore';
import { checkRunConfig, startRun } from './runner';
import { executeAction } from './cf-actions';
import { noteDetails, type ChangeNote } from './change-note';
import { db, isConfigured } from './supabase';
import { jobsPaused, missingFn } from './job-lock';
import { approvalTtlMinutes, expiresAtOf, listApprovals, newApproval, readApproval, saveApproval, type Approval, type ApprovalKind, type ApprovalStatus } from './approvals-store';
import { compactNum } from '@/lib/num';

// Who approves what: an operator's backup needs an admin or super admin; an admin's restore apply needs
// a super admin. Approving starts it at once. Every request and decision goes to the audit log.
// A pending request expires after APPROVAL_TTL_MINUTES (default 30). Its state is also kept in
// Supabase (public.approval_states, migration 0013) and moved with conditional updates —
// pending → approved → executing → done / failed — so a request is carried out once, even with two
// approvers, two workers or a worker that restarts half-way.

/** The permission that lets someone approve (and skip approval for) each kind of request. */
export const APPROVER: Record<ApprovalKind, Permission> = { backup: 'runs:approve', restore: 'restore:approve', cloudflare: 'restore:approve' };
export const canApprove = (me: Pick<Me, 'role'>, kind: ApprovalKind) => can(me.role, APPROVER[kind]);

const yesNo = (b: boolean) => (b ? 'yes' : 'no');

/** An operator asks for a backup: checked like a start, then waits for an admin or super admin. */
export async function requestBackup(me: Me, config: BackupConfig, presetName?: string, note: ChangeNote = {}): Promise<Approval> {
  const checked = await checkRunConfig(config);
  const zones = config.zoneMode === 'all' ? 'all zones' : `${compactNum(config.zoneIds.length)} zone${config.zoneIds.length === 1 ? '' : 's'}`;
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
    ...(note.reason || note.ticket ? { note } : {}),
  });
  await audit(me, 'approval.requested', a.title, { approvalId: a.id, kind: 'backup', preset: presetName ?? null, cloudflare: checked.cloudflare, ...noteDetails(note) });
  return a;
}

// ── The shared state (Supabase) ────────────────────────────────────────────────

type SharedStatus = 'pending' | 'approved' | 'executing' | 'done' | 'failed' | 'rejected' | 'withdrawn' | 'expired';
const gw = globalThis as unknown as { __approvalStateWarned?: boolean };

/**
 * Moves the request's shared state from one of `from` to `to`, only if it is in one of them now.
 * null: there is no shared state (Supabase not configured, or migration 0013 not applied yet), so
 * only this process's own guard applies.
 */
async function moveShared(id: string, from: SharedStatus[], to: SharedStatus, by: string): Promise<{ changed: boolean; current: SharedStatus } | null> {
  if (!isConfigured()) return null;
  const { data, error } = await db().rpc('approval_transition', { p_id: id, p_from: from, p_to: to, p_by: by });
  if (error) {
    if (missingFn(error)) {
      if (!gw.__approvalStateWarned) { gw.__approvalStateWarned = true; console.warn('[approvals] public.approval_states is missing (run supabase/migrations/0013_worker_locks.sql): approvals are guarded on this worker only'); }
      return null;
    }
    throw new HttpError(503, `Could not record the decision in Supabase: ${error.message} — try again`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { changed?: boolean; current_status?: SharedStatus } | undefined;
  return row ? { changed: !!row.changed, current: row.current_status ?? 'pending' } : null;
}

/** After the request is started: recorded, but a failure to record it must not look like a failed start. */
const settleShared = (id: string, to: SharedStatus, by: string) => moveShared(id, ['executing'], to, by)
  .catch((err) => console.error(`[approvals] could not record ${id} as ${to}: ${err instanceof Error ? err.message : String(err)}`));

/** The request was decided elsewhere (another approver or worker): this copy follows, and the caller is told. */
function refuseDecided(a: Approval, current: SharedStatus): never {
  const final: Partial<Record<SharedStatus, ApprovalStatus>> = { done: 'approved', failed: 'failed', rejected: 'rejected', withdrawn: 'withdrawn', expired: 'expired' };
  const local = final[current];
  if (local && a.status === 'pending') {
    Object.assign(a, { status: local, decidedAt: new Date().toISOString(), reason: a.reason ?? `Decided elsewhere (${current})` });
    saveApproval(a);
    if (a.kind === 'restore' && local !== 'approved') dropRestoreApproval(a, `Apply request ${local} elsewhere`, 'console');
  }
  if (current === 'approved' || current === 'executing') {
    throw new HttpError(409, 'This request is already being started (by another approver or worker). If the worker restarted meanwhile, check Runs or Restore history before asking again');
  }
  throw new HttpError(409, `This request is already ${local ?? current}`);
}

// ── Expiry ─────────────────────────────────────────────────────────────────────

const isExpired = (a: Approval) => a.status === 'pending' && expiresAtOf(a) < Date.now();

function expiryReason(a: Approval) {
  const ttl = approvalTtlMinutes();
  const planLimit = a.kind === 'restore' && a.expiresAt && Date.parse(a.expiresAt) < Date.parse(a.requestedAt) + ttl * 60_000;
  return planLimit ? 'The plan got older than 30 minutes before anyone approved it' : `Nobody decided it within ${ttl} minutes — ask again`;
}

/** Marks one pending request expired (here and in Supabase), dropping a restore's held key. */
function expireOne(a: Approval) {
  Object.assign(a, { status: 'expired', decidedAt: new Date().toISOString(), reason: expiryReason(a) });
  saveApproval(a);
  void moveShared(a.id, ['pending'], 'expired', 'console').catch(() => {});
  if (a.kind === 'restore') dropRestoreApproval(a, `Apply request expired — ${expiryReason(a).toLowerCase()}`, 'console');
  void audit(null, 'approval.expired', a.title, { approvalId: a.id, kind: a.kind, requestedBy: a.requestedBy.email });
}

/** Pending requests past their limit expire (and a restore's held key is dropped). */
function expireStale(list: Approval[]): Approval[] {
  for (const a of list) if (isExpired(a) && !deciding.has(a.id)) expireOne(a);
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
      const moved = await moveShared(id, ['pending'], 'rejected', me.email);
      if (moved && !moved.changed) refuseDecided(a, moved.current);
      Object.assign(a, { status: 'rejected', ...decided, ...(note ? { reason: note } : {}) });
      saveApproval(a);
      if (a.kind === 'restore') dropRestoreApproval(a, `Apply request rejected by ${me.email}${note ? `: ${note}` : ''}`, me.email);
      await audit(me, 'approval.rejected', a.title, { approvalId: a.id, kind: a.kind, requestedBy: a.requestedBy.email, reason: note || null, ...noteDetails(a.note) });
      return a;
    }
    // At approval: still pending and in time, and nobody else approved it first.
    if (isExpired(a)) { expireOne(a); throw new HttpError(409, `This request expired: ${a.reason}`); }
    const claimed = await moveShared(id, ['pending'], 'approved', me.email);
    if (claimed && !claimed.changed) refuseDecided(a, claimed.current);
    // At execution: read again (withdrawn or expired meanwhile?), then taken for execution — once.
    const fresh = readApproval(id);
    if (!fresh || fresh.status !== 'pending') {
      void moveShared(id, ['approved'], fresh?.status === 'withdrawn' ? 'withdrawn' : 'failed', me.email).catch(() => {});
      throw new HttpError(409, `This request is already ${fresh?.status ?? 'gone'}`);
    }
    if (isExpired(fresh)) {
      void moveShared(id, ['approved'], 'expired', me.email).catch(() => {});
      expireOne(a);
      throw new HttpError(409, `This request expired: ${a.reason}`);
    }
    const taken = await moveShared(id, ['approved'], 'executing', me.email);
    if (taken && !taken.changed) refuseDecided(a, taken.current);
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
      // Busy (a backup or restore is running), or the worker is about to restart: stays pending,
      // approve again when it is free.
      if (err instanceof HttpError && (err.status === 409 || (err.status === 503 && jobsPaused()))) {
        await moveShared(id, ['executing'], 'pending', me.email).catch(() => {});
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof ApprovalGone ? 'expired' : 'failed';
      await settleShared(id, status, me.email);
      Object.assign(a, { status, ...decided, reason: message });
      saveApproval(a);
      if (a.kind === 'restore') dropRestoreApproval(a, `Apply request could not start: ${message}`, me.email);
      await audit(me, 'approval.failed', a.title, { approvalId: a.id, kind: a.kind, requestedBy: a.requestedBy.email, error: message });
      throw err instanceof HttpError ? err : new HttpError(422, `Approved, but it could not start: ${message}`);
    }
    Object.assign(a, { status: 'approved', ...decided });
    saveApproval(a);
    await settleShared(id, 'done', me.email);
    await audit(me, 'approval.approved', a.title, { approvalId: a.id, kind: a.kind, requestedBy: a.requestedBy.email, ...(a.runId ? { runId: a.runId } : {}), ...(a.restore ? { restoreId: a.restore.restoreId } : {}), ...noteDetails(a.note) });
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
  const moved = await moveShared(id, ['pending'], 'withdrawn', me.email);
  if (moved && !moved.changed) refuseDecided(a, moved.current);
  Object.assign(a, { status: 'withdrawn', decidedBy: { email: me.email, role: me.role }, decidedAt: new Date().toISOString() });
  saveApproval(a);
  if (a.kind === 'restore') dropRestoreApproval(a, 'Apply request withdrawn', me.email);
  await audit(me, 'approval.withdrawn', a.title, { approvalId: a.id, kind: a.kind });
  return a;
}

/** Pending requests this person can decide (for the sidebar badge). */
export const pendingFor = (me: Me) => approvalsFor(me).filter((a) => a.status === 'pending' && canApprove(me, a.kind) && a.requestedBy.id !== me.id).length;
