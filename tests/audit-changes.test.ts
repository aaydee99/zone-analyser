import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReport, CHANGE_AREA, describeChange, type AuditEntry } from '@/lib/audit-changes';

const entry = (action: string, over: Partial<AuditEntry> = {}): AuditEntry => ({ id: 1, at: '2026-01-01T00:00:00Z', actorEmail: 'a@example.com', action, target: null, details: null, ...over });

test('describeChange: plain sentences for known actions', () => {
  assert.equal(describeChange(entry('user.created', { target: 'b@example.com', details: { role: 'viewer' } })), 'Added b@example.com as viewer');
  assert.equal(describeChange(entry('monitoring.settings_updated')), 'Changed the monitoring schedule or notifications');
  assert.equal(describeChange(entry('monitoring.finding_dismissed', { target: 'Weak TLS' })), 'Dismissed a finding: Weak TLS');
});

test('buildReport separates changes from activity and counts per person', () => {
  const since = new Date('2026-01-01T00:00:00Z');
  const until = new Date('2026-01-02T00:00:00Z');
  const entries = [
    entry('user.created', { id: 3, actorEmail: 'b@example.com' }),
    entry('preset.created', { id: 2 }),
    entry('auth.login', { id: 1 }),
    entry('auth.login_failed', { id: 0 }),
  ];
  const r = buildReport(entries, since, until, 1, false);
  assert.deepEqual(r.changes.map((c) => c.action), ['user.created', 'preset.created']);
  assert.equal(r.activity.signIns, 1);
  assert.equal(r.activity.failedSignIns, 1);
  assert.deepEqual(r.people, [{ email: 'a@example.com', changes: 1 }, { email: 'b@example.com', changes: 1 }]);
  assert.ok(Object.keys(CHANGE_AREA).every((a) => /^[a-z_]+\.[a-z_]+$/.test(a)), 'action names are area.verb');
});
