'use client';

import { useEffect, useState } from 'react';
import { MessageSquare, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { api, copyText, relTime } from '@/lib/client';
import { ROLE_META } from '@/lib/rbac';
import { Alert, Badge, Button, Card, EmptyState, Field, Loading, PageHeader, SectionHeader, SkeletonTable } from '@/components/ui';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { useSnapshot } from '../../monitoring/use-run';
import type { SlackLink } from '@/lib/slack-users';

interface View {
  links: SlackLink[]; total: number; offset: number; generatedAt: string;
  setup: { signingSecret: boolean; team: string | null; command: string; requestUrl: string | null };
}
interface ConsoleUser { id: string; email: string; display_name?: string; name?: string; role: string; disabled?: boolean }

export default function SlackSettings() {
  const { can, user } = useMe();
  const toast = useToast();
  const write = can('settings:write');
  const { data, error, loading, reload } = useSnapshot<View>('/api/settings/slack-users?limit=200');
  const manageUsers = can('users:manage');
  const [listed, setListed] = useState<ConsoleUser[] | null>(null);
  const [slackUserId, setSlackUserId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [userId, setUserId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState('');
  const [tryText, setTryText] = useState('help');
  const [answer, setAnswer] = useState('');
  const [trying, setTrying] = useState(false);

  // Admins choose any user they manage; anyone else can link only themselves.
  useEffect(() => {
    if (manageUsers) api<{ users: ConsoleUser[] }>('/api/users').then((r) => setListed(r.users.filter((u) => !u.disabled)), () => setListed(null));
  }, [manageUsers]);
  const users: ConsoleUser[] = listed ?? [{ id: user.id, email: user.email, role: user.role }];
  const chosen = userId || (listed ? '' : user.id);

  const add = async () => {
    setSaving(true);
    try {
      await api('/api/settings/slack-users', { method: 'POST', json: { slackUserId, teamId: teamId || undefined, userId: chosen, note } });
      toast(`${slackUserId.toUpperCase()} may now use ${data?.setup.command ?? 'the command'}`, 'ok');
      setSlackUserId(''); setNote('');
      await reload();
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setSaving(false); }
  };
  const remove = async (id: string) => {
    setRemoving(id);
    try { await api(`/api/settings/slack-users/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast(`${id} removed`, 'ok'); await reload(); }
    catch (e) { toast((e as Error).message, 'bad'); } finally { setRemoving(''); }
  };
  const tryIt = async () => {
    setTrying(true);
    try { setAnswer((await api<{ text: string }>(`/api/slack/answer?text=${encodeURIComponent(tryText)}`)).text); }
    catch (e) { setAnswer((e as Error).message); } finally { setTrying(false); }
  };

  const setup = data?.setup;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Settings" title="Slack command"
        description="A read-only slash command: zone status, findings, configuration search and Ray ID lookups, answered in Slack only to the person who asked. Only the Slack users listed here get an answer, each as the console user they are linked to."
        actions={<Button variant="ghost" loading={loading && !!data} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>} />
      {error && <Alert tone="bad" title="Could not be read">{error}</Alert>}
      {setup && (
        <Card>
          <SectionHeader title="Set-up" description="The Slack app itself is created in Slack (see the README): the console only needs its signing secret." />
          <dl className="grid gap-3 p-5 text-[13px] sm:grid-cols-2">
            <div><dt className="text-muted">Signing secret (SLACK_SIGNING_SECRET)</dt><dd className="mt-0.5">{setup.signingSecret ? <Badge tone="ok">Set</Badge> : <Badge tone="warn">Not set — the command is off</Badge>}</dd></div>
            <div><dt className="text-muted">Command</dt><dd className="mt-0.5 font-mono text-ink-2">{setup.command}</dd></div>
            <div><dt className="text-muted">Request URL for the Slack app</dt><dd className="mt-0.5 flex items-center gap-2 font-mono text-xs break-all text-ink-2">{setup.requestUrl ?? 'https://<your console>/api/hooks/slack (set CONSOLE_PUBLIC_URL to see it here)'}
              {setup.requestUrl && <Button size="sm" variant="ghost" onClick={() => { void copyText(setup.requestUrl!); toast('Copied', 'ok'); }}>Copy</Button>}</dd></div>
            <div><dt className="text-muted">Workspace</dt><dd className="mt-0.5 text-ink-2">{setup.team ? <span className="font-mono">{setup.team}</span> : 'Any workspace the app is installed in (set SLACK_TEAM_ID to allow one only)'}</dd></div>
          </dl>
        </Card>
      )}

      <Card>
        <SectionHeader title="Allowed Slack users" description="Anyone not listed is refused. Each Slack user acts as one console user, with that user's role (removing or disabling the console user stops them too)." />
        {write && (
          <div className="grid gap-3 border-b border-line p-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Slack member ID" hint="Profile › ⋮ › Copy member ID (U…)"><input className="input w-full font-mono" value={slackUserId} onChange={(e) => setSlackUserId(e.target.value)} placeholder="U0123ABCDEF" /></Field>
            <Field label="Acts as">
              <select className="input w-full" value={chosen} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose a console user</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.email} ({ROLE_META[u.role as keyof typeof ROLE_META]?.label ?? u.role})</option>)}
              </select>
            </Field>
            <Field label="Workspace ID" optional hint="T…; empty: any"><input className="input w-full font-mono" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="T0123ABCD" /></Field>
            <Field label="Note" optional><input className="input w-full" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="On-call engineer" /></Field>
            <div className="sm:col-span-2 lg:col-span-4"><Button variant="primary" loading={saving} disabled={!slackUserId || !chosen} onClick={add} icon={<Plus className="size-4" />}>Allow</Button></div>
          </div>
        )}
        {!data ? (!error && <Loading label="Loading Slack users" className="p-5"><SkeletonTable rows={3} cols={4} /></Loading>)
          : !data.links.length ? <div className="p-5"><EmptyState icon={<MessageSquare className="size-5" />} title="Nobody yet" description="Until someone is added, the command answers every Slack user with “not allowed”." /></div>
          : (
            <ul className="divide-y divide-line/70">
              {data.links.map((l) => (
                <li key={l.slackUserId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-[13px]">
                  <div className="min-w-0">
                    <span className="font-mono text-ink">{l.slackUserId}</span>{l.teamId && <span className="ml-2 font-mono text-xs text-muted">{l.teamId}</span>}
                    <span className="ml-2 text-ink-2">→ {l.email || 'deleted user'}</span>
                    {l.role && <Badge className="ml-2">{ROLE_META[l.role].label}</Badge>}
                    {l.disabled && <Badge tone="warn" className="ml-2">Disabled — refused</Badge>}
                    <div className="mt-0.5 text-xs text-muted">{l.note ? `${l.note} · ` : ''}added {relTime(l.addedAt)}{l.addedBy ? ` by ${l.addedBy}` : ''}</div>
                  </div>
                  {write && <Button size="sm" variant="ghost" loading={removing === l.slackUserId} onClick={() => remove(l.slackUserId)} icon={<Trash2 className="size-3.5" />}>Remove</Button>}
                </li>
              ))}
            </ul>
          )}
      </Card>

      <Card>
        <SectionHeader title="Try a command" description="The answer Slack would get, as you." />
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1"><Field label={`${setup?.command ?? '/castellan'} …`}><input className="input w-full font-mono" value={tryText} maxLength={500} onChange={(e) => setTryText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void tryIt(); }} /></Field></div>
            <Button loading={trying} onClick={tryIt} icon={<Send className="size-4" />}>Try</Button>
          </div>
          {answer && <pre className="whitespace-pre-wrap rounded-lg border border-line bg-sunken/60 p-3 font-mono text-xs text-ink-2">{answer}</pre>}
        </div>
      </Card>
    </div>
  );
}
