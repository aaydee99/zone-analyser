import 'server-only';
import type { Me } from './auth';
import { HttpError } from './http';
import { isRole, type Role } from './rbac';
import { db } from './supabase';

// Who sees which backup run and restore:
//   everyone      their own (they started it, asked for it, or approved it);
//   admins        also those of operators and viewers (people below them);
//   super admins  every record, also those that belong to no current user (scheduled runs, a
//                 deleted user).
// A record someone may not see answers 404 (it is not listed and cannot be opened), as if it did not exist.

/** Roles below an admin, whose records an admin also sees. */
const BELOW_ADMIN: ReadonlySet<Role> = new Set(['operator', 'viewer']);
const KEEP_MS = 30_000;
let roles: { at: number; byEmail: Promise<Map<string, Role>> } | null = null;

/** Each user's current role, by email (lower case); read at most every 30 seconds. */
function rolesByEmail(): Promise<Map<string, Role>> {
  if (roles && Date.now() - roles.at < KEEP_MS) return roles.byEmail;
  const byEmail = (async () => {
    const { data, error } = await db().from('profiles').select('email, role');
    if (error) throw new Error(`Reading users failed: ${error.message}`);
    return new Map((data as { email: string | null; role: string }[]).filter((r) => r.email && isRole(r.role)).map((r) => [r.email!.toLowerCase(), r.role as Role]));
  })();
  roles = { at: Date.now(), byEmail };
  byEmail.catch(() => { if (roles?.byEmail === byEmail) roles = null; });
  return byEmail;
}

/** A visibility check for `me`: true when one of the record's people (emails) makes it theirs to see. */
export async function recordFilter(me: Me): Promise<(owners: (string | null | undefined)[]) => boolean> {
  if (me.role === 'super_admin') return () => true;
  const mine = me.email.toLowerCase();
  const byEmail = me.role === 'admin' ? await rolesByEmail() : null;
  return (owners) => owners.some((o) => {
    const e = (o ?? '').trim().toLowerCase();
    if (!e) return false;
    if (e === mine) return true;
    const role = byEmail?.get(e);
    return !!role && BELOW_ADMIN.has(role);
  });
}

/** Refuses (404, `what` not found) a record `me` may not see. */
export async function mustSee(me: Me, owners: (string | null | undefined)[], what: string) {
  if (!(await recordFilter(me))(owners)) throw new HttpError(404, `${what} not found`);
}

/** The people of a backup run: who started it, and (from an approved request) who asked and who approved. */
export function runOwners(run: { id: string; startedBy?: string }, approvals: { runId?: string; requestedBy: { email: string }; decidedBy?: { email: string } | null }[]) {
  const a = approvals.find((x) => x.runId === run.id);
  return [run.startedBy, a?.requestedBy.email, a?.decidedBy?.email];
}

/** Refuses (404) a run `me` may not see. */
export async function mustSeeRun(me: Me, run: { id: string; startedBy?: string }) {
  const { listApprovals } = await import('./approvals-store');
  await mustSee(me, runOwners(run, listApprovals()), 'Run');
}

/** The people of a restore: who started it and who applied it. */
export const restoreOwners = (r: { createdBy?: string | null; appliedBy?: string | null }) => [r.createdBy, r.appliedBy];

/** Refuses (404) a running restore session `me` may not see (before it is shown or acted on). */
export async function mustSeeRestore(me: Me, id: string) {
  const { getRestore } = await import('./restore');
  const v = getRestore(id);
  await mustSee(me, restoreOwners(v as { createdBy?: string; appliedBy?: string | null }), 'Restore session');
  return v;
}
