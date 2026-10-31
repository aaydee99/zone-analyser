'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api } from '@/lib/client';
import { ROLE_META, type Permission } from '@/lib/rbac';
import { Badge, Button, Card, Field, PageHeader, SectionHeader } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useMe } from '@/components/me';
import { PasswordStrength } from '@/components/auth-frame';

const PERM_LABEL: Record<Permission, string> = {
  'runs:read': 'View runs, live logs and backup files',
  'runs:start': 'Start backups and use presets (an admin approves them unless you can approve)',
  'runs:cancel': 'Cancel running backups',
  'runs:delete': 'Delete run records',
  'presets:write': 'Save and delete presets',
  'settings:read': 'View settings',
  'settings:write': 'Change settings',
  'tools:manage': 'Install and remove terraform / cf-terraforming',
  'users:manage': 'Manage users and roles',
  'audit:read': 'Read the audit log, recent changes and Cloudflare activity',
  'cloudflare:revert': 'Revert a change from Cloudflare activity (with a Global API Key)',
  'restore:run': 'Restore zone configuration from a backup (plan, then apply — a super admin approves the apply unless you can approve)',
  'runs:approve': 'Start backups without approval, and approve or reject operator backup requests',
  'restore:approve': 'Apply restores and Cloudflare changes without approval, and approve or reject admins’ requests',
  'monitors:manage': 'Run the monitoring checks, dismiss findings, accept drift and set up notifications',
  'cloudflare:act': 'Ask for a cache purge or a Worker / Pages rollback (a super admin approves it)',
  'vault:access': 'Open the credential vault (with the vault password)',
};

export default function AccountPage() {
  const toast = useToast();
  const { user, permissions } = useMe();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.next !== f.confirm) return toast('New passwords do not match', 'bad');
    setBusy(true);
    try {
      await api('/api/auth/password', { method: 'POST', json: { current: f.current, next: f.next } });
      setF({ current: '', next: '', confirm: '' });
      toast('Password changed — other sessions were signed out');
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(false); }
  };

  return (
    <div className="rise">
      <PageHeader eyebrow="Account" title={user.name || user.email} description={user.name ? user.email : undefined} />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <SectionHeader title="Your role" aside={<Badge tone={user.role === 'super_admin' ? 'signal' : 'neutral'}>{ROLE_META[user.role].label}</Badge>} description={ROLE_META[user.role].description} />
          <ul className="space-y-2 px-5 py-4 text-[13px]">
            {permissions.map((p) => <li key={p} className="flex items-center gap-2 text-ink-2"><span className="size-1.5 rounded-full bg-ok" aria-hidden />{PERM_LABEL[p]}</li>)}
          </ul>
        </Card>
        <Card>
          <SectionHeader title="Sign-in password" description={user.role === 'super_admin' ? 'Separate from the vault password, which is changed on the Credentials page.' : 'Used to sign in to the console.'} />
          <form onSubmit={submit} className="space-y-4 p-5">
            <Field label="Current password" htmlFor="a1"><input id="a1" type="password" autoComplete="current-password" className="input font-mono" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="New password" htmlFor="a2">
                <input id="a2" type="password" autoComplete="new-password" className="input font-mono" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
                <PasswordStrength value={f.next} />
              </Field>
              <Field label="Confirm new password" htmlFor="a3"><input id="a3" type="password" autoComplete="new-password" className="input font-mono" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
            </div>
            <div className="flex justify-end">
              <Button type="submit" loading={busy} disabled={!f.current || f.next.length < 12} icon={<KeyRound className="size-4" />}>Change password</Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
