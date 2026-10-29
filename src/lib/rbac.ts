// Roles and permissions. Shared by server and client — no Node imports.
// The server is the only enforcement point; the client uses this to hide UI.

export type Role = 'super_admin' | 'admin' | 'operator' | 'viewer';

export const ROLES: Role[] = ['super_admin', 'admin', 'operator', 'viewer'];

export const ROLE_META: Record<Role, { label: string; description: string }> = {
  super_admin: { label: 'Super admin', description: 'Everything, including the credential vault, admins and other super admins.' },
  admin: { label: 'Admin', description: 'Operators and viewers, settings, tools, presets, runs, the audit log and restores; approves operator backups. Applying a restore needs super admin approval.' },
  operator: { label: 'Operator', description: 'Request backups (an admin approves them), cancel backups, use and save presets, browse backup files.' },
  viewer: { label: 'Viewer', description: 'Read-only, but sees full backup contents (the whole Cloudflare configuration) and live logs.' },
};

export type Permission =
  | 'runs:read'
  | 'runs:start'
  | 'runs:cancel'
  | 'runs:delete'
  | 'presets:write'
  | 'settings:read'
  | 'settings:write'
  | 'tools:manage'
  | 'users:manage'
  | 'audit:read'
  | 'cloudflare:revert'
  | 'restore:run'
  /** Start a backup without approval, and approve or reject operators' backup requests. */
  | 'runs:approve'
  /** Apply a restore without approval, and approve or reject admins' restore requests. */
  | 'restore:approve'
  | 'vault:access';

const BASE: Permission[] = ['runs:read'];
const OPERATOR: Permission[] = [...BASE, 'runs:start', 'runs:cancel', 'presets:write'];
const ADMIN: Permission[] = [...OPERATOR, 'runs:delete', 'runs:approve', 'settings:read', 'settings:write', 'tools:manage', 'users:manage', 'audit:read', 'restore:run'];

export const PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(BASE),
  operator: new Set(OPERATOR),
  admin: new Set(ADMIN),
  // Only super admins ever reach the vault, revert Cloudflare changes, or apply a restore without approval.
  super_admin: new Set<Permission>([...ADMIN, 'vault:access', 'cloudflare:revert', 'restore:approve']),
};

export const can = (role: Role | undefined | null, perm: Permission) => !!role && PERMISSIONS[role].has(perm);

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, super_admin: 3 };

/**
 * Whether `actor` may create, edit or remove a user that has (or would get) `target`.
 * Admins manage only roles below their own, so one admin cannot reset another admin's
 * password and sign in as them; admins are managed by super admins.
 */
export function canManageRole(actor: Role, target: Role) {
  if (!can(actor, 'users:manage')) return false;
  if (actor === 'super_admin') return true;
  return RANK[target] < RANK[actor];
}

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as string[]).includes(v);
