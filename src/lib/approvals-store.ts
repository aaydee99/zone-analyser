import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { Role } from './rbac';
import type { BackupConfig } from './config';
import { DATA_DIR, newId } from './store';
import { mirrorFile } from './state-mirror';

// Approval requests: an operator's backup waits for an admin or super admin; an admin's restore apply
// waits for a super admin. One record per request in data/approvals/<id>.json. Records hold no secrets:
// a restore's Global API Key is held in server memory only, never here.

const DIR = path.join(DATA_DIR, 'approvals');
export const APPROVAL_ID = /^[A-Za-z0-9_-]{8,32}$/;

export type ApprovalKind = 'backup' | 'restore';
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
  /** Pending until then (restores: the plan's age limit). */
  expiresAt?: string;
  backup?: { config: BackupConfig; presetName?: string };
  /** The run an approved backup started. */
  runId?: string;
  restore?: { restoreId: string; zone: string; folder: string; keyEmail: string; planAt: string; changes: { address: string; actions: string[] }[] };
}

const file = (id: string) => path.join(DIR, `${id}.json`);

export function saveApproval(a: Approval) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file(a.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(a), { mode: 0o600 });
  fs.renameSync(tmp, file(a.id));
  mirrorFile(`approvals/${a.id}.json`, a);
}

export function newApproval(a: Omit<Approval, 'id' | 'status' | 'requestedAt'>): Approval {
  const rec: Approval = { ...a, id: newId(9), status: 'pending', requestedAt: new Date().toISOString() };
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
