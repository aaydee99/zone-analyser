'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Lock, Pencil, Trash2, UserPlus } from 'lucide-react';
import { api, relTime } from '@/lib/client';
import { canManageRole, ROLE_META, ROLES, type Role } from '@/lib/rbac';
import { Badge, Button, Card, EmptyState, Field, Loading, Modal, PageHeader, Skeleton, Switch, cx } from '@/components/ui';
import { useToast } from '@/components/toast';
import { useMe } from '@/components/me';
import { PasswordStrength } from '@/components/auth-frame';

interface UserView { id: string; email: string; name: string; role: Role; disabled: boolean; createdAt: string; lastLoginAt: string | null }

const ROLE_TONE: Record<Role, 'signal' | 'info' | 'ok' | 'neutral'> = { super_admin: 'signal', admin: 'info', operator: 'ok', viewer: 'neutral' };

function RolePicker({ value, onChange, allowed }: { value: Role; onChange: (r: Role) => void; allowed: Role[] }) {
  return (
    <div className="grid gap-2" role="radiogroup" aria-label="Role">
      {ROLES.filter((r) => allowed.includes(r)).map((r) => (
        <button key={r} type="button" role="radio" aria-checked={value === r} onClick={() => onChange(r)}
          className={cx('rounded-xl border px-3 py-2.5 text-left transition-colors duration-150',
            value === r ? 'border-signal/60 bg-signal/[0.07]' : 'border-line bg-sunken/60 hover:border-line-strong')}>
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className={cx('size-3.5 rounded-full border-2', value === r ? 'border-signal bg-signal shadow-[inset_0_0_0_2px_var(--color-surface)]' : 'border-line-strong')} />
            {ROLE_META[r].label}
          </span>
          <span className="mt-1 block pl-[22px] text-xs text-muted">{ROLE_META[r].description}</span>
        </button>
      ))}
    </div>
  );
}

function UserEditor({ open, onClose, initial, onSaved }: { open: boolean; onClose: () => void; initial: UserView | null; onSaved: () => void }) {
  const toast = useToast();
  const me = useMe();
  const allowed = ROLES.filter((r) => canManageRole(me.user.role, r));
  const [f, setF] = useState({ name: '', email: '', role: 'operator' as Role, password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setF({ name: initial?.name ?? '', email: initial?.email ?? '', role: initial?.role ?? 'operator', password: '' });
      setError('');
    }
  }, [open, initial]);

  const self = initial?.id === me.user.id;
  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      if (initial) {
        const patch: Record<string, unknown> = { name: f.name };
        if (!self && f.role !== initial.role) patch.role = f.role;
        if (!self && f.password) patch.password = f.password;
        await api(`/api/users/${initial.id}`, { method: 'PATCH', json: patch });
        toast('User updated');
      } else {
        await api('/api/users', { method: 'POST', json: f });
        toast(`${f.email} added`);
      }
      onSaved();
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} width="max-w-xl" title={initial ? `Edit ${initial.email}` : 'Add user'}
      description={initial ? 'Role and password changes sign the user out everywhere.' : 'Creates a Supabase Auth account. Share the initial password securely; they can change it from Account.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>{initial ? 'Save' : 'Add user'}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" optional htmlFor="u-name"><input id="u-name" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email" htmlFor="u-email"><input id="u-email" type="email" className="input" disabled={!!initial} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        {!self && (
          <Field label={initial ? 'Reset password' : 'Initial password'} optional={!!initial} htmlFor="u-pw" hint={initial ? 'Leave blank to keep the current password.' : 'At least 12 characters.'}>
            <input id="u-pw" type="password" autoComplete="new-password" className="input font-mono" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            <PasswordStrength value={f.password} />
          </Field>
        )}
        {self ? <p className="text-[13px] text-muted">You cannot change your own role. Use Account to change your password.</p>
          : <div><div className="mb-1.5 text-[13px] font-medium text-ink-2">Role</div><RolePicker value={f.role} onChange={(role) => setF({ ...f, role })} allowed={allowed} /></div>}
        {error && <p role="alert" className="rounded-lg border border-bad/25 bg-bad/[0.06] px-3 py-2 text-[13px] text-bad">{error}</p>}
      </div>
    </Modal>
  );
}

export default function UsersPage() {
  const toast = useToast();
  const me = useMe();
  const [users, setUsers] = useState<UserView[] | null>(null);
  const [editing, setEditing] = useState<UserView | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<UserView | null>(null);

  const allowed = me.can('users:manage');
  const load = useCallback(() => api<{ users: UserView[] }>('/api/users').then((r) => setUsers(r.users)), []);
  useEffect(() => { if (allowed) load().catch((e) => toast(e.message, 'bad')); }, [load, toast, allowed]);

  if (!allowed) {
    return <Card className="rise mx-auto mt-6 max-w-lg"><EmptyState icon={<Lock className="size-5" />} title="Admins only" description="Ask an admin to change roles or add people." /></Card>;
  }

  const toggle = async (u: UserView, disabled: boolean) => {
    try { await api(`/api/users/${u.id}`, { method: 'PATCH', json: { disabled } }); toast(disabled ? `${u.email} disabled` : `${u.email} enabled`); load(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  const remove = async () => {
    if (!deleting) return;
    try { await api(`/api/users/${deleting.id}`, { method: 'DELETE' }); toast('User deleted'); setDeleting(null); load(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };

  return (
    <div className="rise">
      <PageHeader eyebrow="Access" title="Users & roles"
        description="Accounts live in Supabase Auth. Roles decide what each person can do; only super admins can open the credential vault."
        actions={<Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => { setEditing(null); setEditorOpen(true); }}>Add user</Button>} />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {ROLES.map((r) => (
          <div key={r} className="panel px-4 py-3">
            <div className="flex items-center justify-between">
              <Badge tone={ROLE_TONE[r]}>{ROLE_META[r].label}</Badge>
              {users ? <span className="font-mono text-sm tabular-nums text-ink-2">{users.filter((u) => u.role === r).length}</span> : <Skeleton className="h-3.5 w-4" />}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">{ROLE_META[r].description}</p>
          </div>
        ))}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-muted">
                {['User', 'Role', 'Last sign-in', 'Added', 'Active', ''].map((h) => (
                  <th key={h} className="px-5 py-3 text-[11px] font-semibold tracking-[0.1em] uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => {
                const manageable = canManageRole(me.user.role, u.role);
                const self = u.id === me.user.id;
                return (
                  <tr key={u.id} className={cx('border-b border-line/60 last:border-0', u.disabled && 'opacity-55')}>
                    <td className="px-5 py-3">
                      <div className="font-medium text-ink">{u.name || u.email}{self && <span className="ml-2 text-[11px] text-faint">you</span>}</div>
                      {u.name && <div className="text-xs text-muted">{u.email}</div>}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={ROLE_TONE[u.role]}>{u.role === 'super_admin' && <KeyRound className="size-3" aria-hidden />}{ROLE_META[u.role].label}</Badge>
                    </td>
                    <td className="px-5 py-3 text-ink-2">{u.lastLoginAt ? relTime(u.lastLoginAt) : <span className="text-faint">never</span>}</td>
                    <td className="px-5 py-3 text-ink-2">{relTime(u.createdAt)}</td>
                    <td className="px-5 py-3">
                      <Switch checked={!u.disabled} disabled={!manageable || self} onChange={(v) => toggle(u, !v)} label={`${u.disabled ? 'Enable' : 'Disable'} ${u.email}`} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      {manageable && (
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => { setEditing(u); setEditorOpen(true); }}>Edit</Button>
                          {!self && <Button size="sm" variant="ghost" className="hover:!text-bad" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(u)} aria-label={`Delete ${u.email}`} />}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!users && (
          <Loading label="Loading users">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-6 border-b border-line/60 px-5 py-3.5 last:border-0">
                <div className="w-1/4 min-w-0 space-y-1.5"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-3 w-44 max-w-full" /></div>
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-9 rounded-full" />
              </div>
            ))}
          </Loading>
        )}
      </Card>

      <UserEditor open={editorOpen} onClose={() => setEditorOpen(false)} initial={editing} onSaved={load} />
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete user?"
        description={deleting ? `${deleting.email} loses access immediately and their Supabase account is removed.` : ''}
        footer={<><Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button><Button variant="danger" icon={<Trash2 className="size-4" />} onClick={remove}>Delete</Button></>}>
        <p className="text-sm text-muted">Runs and audit entries they created are kept. To pause access instead, switch the account off.</p>
      </Modal>
    </div>
  );
}
