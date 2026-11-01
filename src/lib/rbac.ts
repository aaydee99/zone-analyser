// Roles and permissions. Shared by server and client — no Node imports.
// The server is the only enforcement point; the client uses this to hide UI.

export type Role = 'super_admin' | 'admin' | 'operator' | 'viewer';

export const ROLES: Role[] = ['super_admin', 'admin', 'operator', 'viewer'];

export const ROLE_META: Record<Role, { label: string; description: string }> = {
  super_admin: { label: 'Super admin', description: 'Everything, including the credential vault, admins and other super admins.' },
  admin: { label: 'Admin', description: 'Operators and viewers, settings, tools, presets, runs, restores, monitoring and the API console; approves backup requests and reverts Cloudflare changes. Applying a restore, purging the cache or rolling back a deployment needs super admin approval.' },
  operator: { label: 'Operator', description: 'Everything a viewer can do, plus cancel backups and save presets.' },
  viewer: { label: 'Viewer', description: 'Sees every page read-only (full backup contents, Cloudflare activity, live Worker logs) and can request backups, which an admin approves. Never restores or changes Cloudflare.' },
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
  /** The console's own audit log and recent changes: super admins only. */
  | 'audit:read'
  /** Cloudflare activity: what changed in Cloudflare, read-only. */
  | 'activity:read'
  /** Live Worker logs (a tail of a Worker's console output). */
  | 'workers:tail'
  /** The Tokens & members monitoring check: API tokens and account members. */
  | 'governance:read'
  | 'cloudflare:revert'
  | 'restore:run'
  /** Start a backup without approval, and approve or reject operators' backup requests. */
  | 'runs:approve'
  /** Apply a restore without approval, and approve or reject admins' restore requests. */
  | 'restore:approve'
  | 'vault:access'
  /** Run the monitoring checks now, dismiss findings, accept drift, set up notifications. */
  | 'monitors:manage'
  /** Ask for a Cloudflare change (cache purge, rollback); a super admin approves it. */
  | 'cloudflare:act'
  /** Set zone tags, owners and comparison templates (kept in the console, never sent to Cloudflare). */
  | 'zones:tag'
  /** Read-only Cloudflare API console and live Worker logs, with the stored tokens. */
  | 'cloudflare:query';

// Viewers see everything read-only and can ask for a backup (runs:start without runs:approve = an approval request).
const VIEWER: Permission[] = ['runs:read', 'activity:read', 'workers:tail', 'runs:start'];
const OPERATOR: Permission[] = [...VIEWER, 'runs:cancel', 'presets:write'];
const ADMIN: Permission[] = [...OPERATOR, 'runs:delete', 'runs:approve', 'settings:read', 'settings:write', 'tools:manage', 'users:manage', 'restore:run', 'monitors:manage', 'cloudflare:act', 'zones:tag', 'cloudflare:query', 'cloudflare:revert', 'governance:read'];

export const PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  operator: new Set(OPERATOR),
  admin: new Set(ADMIN),
  // Only super admins ever reach the vault or the console's audit log, or apply a restore without approval.
  super_admin: new Set<Permission>([...ADMIN, 'vault:access', 'audit:read', 'restore:approve']),
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
