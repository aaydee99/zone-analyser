import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERMISSIONS, ROLES, can, canManageRole, isRole } from '@/lib/rbac';

test('every role reads runs; only super admins reach the vault, the audit log, approve restores or revert Cloudflare One changes', () => {
  for (const r of ROLES) assert.ok(can(r, 'runs:read'), r);
  for (const p of ['vault:access', 'audit:read', 'restore:approve', 'cloudflare:revert_one'] as const) {
    assert.deepEqual(ROLES.filter((r) => can(r, p)), ['super_admin'], p);
  }
});

test('viewers see Cloudflare activity and Worker logs and request backups, but never restore, revert or approve', () => {
  for (const p of ['activity:read', 'workers:tail', 'runs:start'] as const) assert.ok(can('viewer', p), p);
  for (const p of ['restore:run', 'cloudflare:revert', 'cloudflare:act', 'cloudflare:query', 'runs:approve', 'runs:cancel', 'settings:read', 'users:manage'] as const) {
    assert.equal(can('viewer', p), false, p);
  }
  assert.deepEqual(ROLES.filter((r) => can(r, 'cloudflare:revert')).sort(), ['admin', 'super_admin']);
});

test('roles only gain permissions going up', () => {
  const order = ['viewer', 'operator', 'admin', 'super_admin'] as const;
  for (let i = 1; i < order.length; i++) {
    for (const p of PERMISSIONS[order[i - 1]]) assert.ok(PERMISSIONS[order[i]].has(p), `${order[i]} lacks ${p}`);
  }
});

test('monitoring, cache purge and rollback requests are for admins and up', () => {
  for (const p of ['monitors:manage', 'cloudflare:act'] as const) {
    assert.deepEqual(ROLES.filter((r) => can(r, p)).sort(), ['admin', 'super_admin'], p);
  }
});

test('can() is false without a role', () => {
  assert.equal(can(undefined, 'runs:read'), false);
  assert.equal(can(null, 'runs:read'), false);
});

test('canManageRole: admins manage only roles below their own', () => {
  assert.equal(canManageRole('admin', 'operator'), true);
  assert.equal(canManageRole('admin', 'viewer'), true);
  assert.equal(canManageRole('admin', 'admin'), false);
  assert.equal(canManageRole('admin', 'super_admin'), false);
  assert.equal(canManageRole('super_admin', 'super_admin'), true);
  assert.equal(canManageRole('operator', 'viewer'), false);
});

test('isRole', () => {
  assert.equal(isRole('admin'), true);
  assert.equal(isRole('root'), false);
  assert.equal(isRole(3), false);
});
