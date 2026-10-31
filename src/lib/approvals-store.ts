import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { Role } from './rbac';
import type { BackupConfig } from './config';
import type { CfAction } from './cf-actions';
import { DATA_DIR, newId } from './store';
import { mirrorFile } from './state-mirror';
import { checkChangeNote, type ChangeNote } from './change-note';
import { getSettings } from './settings';
import { HttpError } from './http';

// Approval requests: an operator's backup waits for an admin or super admin; an admin's restore apply
// waits for a super admin. One record per request in data/approvals/<id>.json. Records hold no secrets:
// a restore's Global API Key is held in server memory only, never here.

const DIR = path.join(DATA_DIR, 'approvals');
export const APPROVAL_ID = /^[A-Za-z0-9_-]{8,32}$/;

export type ApprovalKind = 'backup' | 'restore' | 'cloudflare';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'failed';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  requestedBy: { id: string; email: string; role: Role };
  requestedAt: string;
  /** Who approved, rejected or withdrew it, and when. */
  decidedBy?: { email: string; role: Role };
  decidedAt?: string;
  /** A rejection's reason, or why it failed or expired. */
  reason?: string;
  title: string;
  /** What the approver is asked to approve, one line each. */
  details: string[];
  /** Pending until then: APPROVAL_TTL_MINUTES after it was asked, or a restore plan's age limit if sooner. */
  expiresAt?: string;
  backup?: { config: BackupConfig; presetName?: string };
  /** The run an approved backup started. */
  runId?: string;
  /** A Cloudflare change (cache purge, rollback) and, once done, what happened. */
  action?: CfAction;
  result?: string;
  restore?: { restoreId: string; zone: string; folder: string; keyEmail: string; planAt: string; changes: { address: string; actions: string[] }[] };
  /** Why the requester asks, and their change ticket (optional; requests saved before it have none). */
  note?: ChangeNote;
}

/**
 * The reason and ticket of a request, from the `reason` and `ticket` fields of the request body
 * (every kind of request takes them the same way). `asking`: it becomes an approval request, where
 * the Settings may require a reason; a direct action only records what was given.
 */
export async function requestNote(raw: unknown, asking = true): Promise<ChangeNote> {
  try {
    return checkChangeNote(raw, asking && (await getSettings()).requireReason);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

const file = (id: string) => path.join(DIR, `${id}.json`);

/** A request nobody decides within APPROVAL_TTL_MINUTES (default 30) expires. */
export const approvalTtlMinutes = () => Math.max(1, Number(process.env.APPROVAL_TTL_MINUTES) || 30);

/**
 * When a pending request expires: its own limit (a restore's plan age) or APPROVAL_TTL_MINUTES after
 * it was asked, whichever comes first. Also right for requests saved before the TTL existed.
 */
export function expiresAtOf(a: Pick<Approval, 'requestedAt' | 'expiresAt'>): number {
  const ttl = Date.parse(a.requestedAt) + approvalTtlMinutes() * 60_000;
  const own = a.expiresAt ? Date.parse(a.expiresAt) : NaN;
  return Number.isNaN(own) ? ttl : Math.min(own, ttl);
}

export function saveApproval(a: Approval) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file(a.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(a), { mode: 0o600 });
  fs.renameSync(tmp, file(a.id));
  mirrorFile(`approvals/${a.id}.json`, a);
}

export function newApproval(a: Omit<Approval, 'id' | 'status' | 'requestedAt'>): Approval {
  const requestedAt = new Date().toISOString();
  const rec: Approval = { ...a, id: newId(9), status: 'pending', requestedAt, expiresAt: new Date(expiresAtOf({ requestedAt, expiresAt: a.expiresAt })).toISOString() };
  saveApproval(rec);
  return rec;
}

export function readApproval(id: string): Approval | null {
  if (!APPROVAL_ID.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')) as Approval; } catch { return null; }
}

/** Every request, newest first. */
export function listApprovals(): Approval[] {
  let names: string[] = [];
  try { names = fs.readdirSync(DIR).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names.map((n) => readApproval(n.slice(0, -5))).filter((a): a is Approval => !!a).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
}
