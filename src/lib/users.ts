import 'server-only';
import { db, must } from './supabase';
import { audit } from './audit';
import { AuthError, authApiMessage, checkPassword, invalidateUser, revokeUserSessions, type Me } from './auth';
import { canManageRole, isRole, type Role } from './rbac';

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface Row { id: string; email: string; display_name: string; role: Role; disabled: boolean; created_at: string; last_login_at: string | null }
const view = (r: Row): UserView => ({
  id: r.id, email: r.email, name: r.display_name, role: r.role, disabled: r.disabled, createdAt: r.created_at, lastLoginAt: r.last_login_at,
});
const COLS = 'id, email, display_name, role, disabled, created_at, last_login_at';

export async function listUsers(): Promise<UserView[]> {
  const rows = must(await db().from('profiles').select(COLS).order('created_at'), 'Listing users') as Row[];
  return rows.map(view);
}

async function getUser(id: string): Promise<Row> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AuthError('User not found', 404);
  const row =must(await db().from('profiles').select(COLS).eq('id', id).maybeSingle(), 'Reading user') as Row | null;
  if (!row) throw new AuthError('User not found', 404);
  return row;
}

/** The database's own last-super-admin refusal (supabase/migrations/0008). */
const lastSuperAdmin = (message: string) => /last super admin/i.test(message);

async function activeSuperAdmins(): Promise<number> {
  const { count } = await db().from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'super_admin').eq('disabled', false);
  return count ?? 0;
}

export async function createUser(actor: Me, input: { email?: string; name?: string; role?: string; password?: string }): Promise<UserView> {
  const email = (input.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address', 400);
  if (!isRole(input.role)) throw new AuthError('Choose a role', 400);
  if (!canManageRole(actor.role, input.role)) throw new AuthError('You cannot grant this role', 403);
  checkPassword(input.password, 'Initial password');

  const { data, error } = await db().auth.admin.createUser({ email, password: input.password, email_confirm: true });
  if (error || !data.user) {
    throw new AuthError(/already/i.test(error?.message ?? '') ? 'An account with this email already exists' : authApiMessage(error, 'Could not create the user'), 400);
  }
  const { data: row, error: pErr } = await db().from('profiles')
    .insert({ id: data.user.id, email, display_name: (input.name ?? '').trim().slice(0, 80), role: input.role })
    .select(COLS).single();
  if (pErr) {
    await db().auth.admin.deleteUser(data.user.id).catch(() => {});
    throw new Error(`Could not create the profile: ${pErr.message}`);
  }
  await audit(actor, 'user.created', email, { role: input.role });
  return view(row as Row);
}

export async function updateUser(actor: Me, id: string, patch: { name?: string; role?: string; disabled?: boolean; password?: string }): Promise<UserView> {
  const target = await getUser(id);
  const self = id === actor.id;
  if (!canManageRole(actor.role, target.role)) throw new AuthError('You cannot manage this user', 403);

  const update: Partial<Row> = {};
  const changes: Record<string, unknown> = {};
  if (patch.name !== undefined) { update.display_name = String(patch.name).trim().slice(0, 80); changes.name = update.display_name; }
  if (patch.role !== undefined && patch.role !== target.role) {
    if (!isRole(patch.role)) throw new AuthError('Unknown role', 400);
    if (self) throw new AuthError('You cannot change your own role', 400);
    if (!canManageRole(actor.role, patch.role)) throw new AuthError('You cannot grant this role', 403);
    if (target.role === 'super_admin' && !target.disabled && (await activeSuperAdmins()) <= 1) throw new AuthError('This is the last super admin', 400);
    update.role = patch.role;
    changes.role = { from: target.role, to: patch.role };
  }
  if (patch.disabled !== undefined && patch.disabled !== target.disabled) {
    if (self) throw new AuthError('You cannot disable your own account', 400);
    if (patch.disabled && target.role === 'super_admin' && (await activeSuperAdmins()) <= 1) throw new AuthError('This is the last super admin', 400);
    update.disabled = !!patch.disabled;
    changes.disabled = update.disabled;
  }
  if (patch.password !== undefined) {
    if (self) throw new AuthError('Change your own password from Account', 400);
    checkPassword(patch.password, 'New password');
    const { error } = await db().auth.admin.updateUserById(id, { password: patch.password });
    if (error) throw new AuthError(authApiMessage(error, 'Could not reset the password'), 400);
    changes.password = 'reset';
  }

  let row = target;
  if (Object.keys(update).length) {
    const res = await db().from('profiles').update({ ...update, updated_at: new Date().toISOString() }).eq('id', id).select(COLS).single();
    // The database refuses a change that would leave no enabled super admin (two changes at once).
    if (res.error && lastSuperAdmin(res.error.message)) throw new AuthError('This is the last super admin', 400);
    row = must(res, 'Updating user') as Row;
  }
  // Disabling, demoting or resetting a password signs the user out everywhere.
  if (update.disabled || update.role || changes.password) await revokeUserSessions(id);
  else invalidateUser(id);
  if (Object.keys(changes).length) await audit(actor, 'user.updated', target.email, changes);
  return view(row);
}

export async function deleteUser(actor: Me, id: string) {
  const target = await getUser(id);
  if (id === actor.id) throw new AuthError('You cannot delete your own account', 400);
  if (!canManageRole(actor.role, target.role)) throw new AuthError('You cannot manage this user', 403);
  if (target.role === 'super_admin' && !target.disabled && (await activeSuperAdmins()) <= 1) throw new AuthError('This is the last super admin', 400);
  await revokeUserSessions(id);
  // Deleting the auth user cascades to the profile and its sessions.
  const { error } = await db().auth.admin.deleteUser(id);
  if (error) throw lastSuperAdmin(error.message) ? new AuthError('This is the last super admin', 400) : new Error(`Could not delete user: ${error.message}`);
  await audit(actor, 'user.deleted', target.email, { role: target.role });
}
