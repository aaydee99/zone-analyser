'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Eraser } from 'lucide-react';
import { api } from '@/lib/client';
import type { ZoneListItem } from '@/lib/zone-catalog';
import { Alert, Button, Card, Field, Loading, Modal, PageHeader, SectionHeader, Segmented, Skeleton } from '@/components/ui';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { ChangeNoteFields, noteBody, noteReady, useRequireReason } from '@/components/change-note';
import { EMPTY_CREDENTIAL, RuntimeCredentialFields, credentialBody, credentialReady, type RuntimeCredentialInput } from '@/components/runtime-credential';
import type { ChangeNote } from '@/lib/change-note';

type Mode = 'files' | 'tags' | 'hosts' | 'prefixes' | 'everything';
const MODES: { value: Mode; label: string }[] = [
  { value: 'files', label: 'URLs' }, { value: 'prefixes', label: 'Prefixes' }, { value: 'hosts', label: 'Host names' }, { value: 'tags', label: 'Cache tags' }, { value: 'everything', label: 'Everything' },
];
const HINT: Record<Mode, string> = {
  files: 'Full URLs, one per line, e.g. https://example.com/styles/site.css',
  prefixes: 'A host and path, without https://, one per line, e.g. example.com/blog/',
  hosts: 'Host names, one per line, e.g. images.example.com',
  tags: 'Cache-Tag values your origin sends, one per line',
  everything: '',
};
const MAX = 100;
/** Above this many zones in an account, a name filter is shown over the zone list. */
const FILTER_FROM = 50;

export default function PurgePage() {
  const { can } = useMe();
  const toast = useToast();
  const [zones, setZones] = useState<ZoneListItem[] | null>(null);
  const [accountId, setAccountId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [find, setFind] = useState('');
  const [mode, setMode] = useState<Mode>('files');
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ done?: string; approval?: { id: string } } | null>(null);
  const direct = can('restore:approve');
  const [note, setNote] = useState<ChangeNote>({});
  const requireReason = useRequireReason();
  // A purge never runs with a stored token: whoever runs it types a credential in (held here only, cleared after sending).
  const [cred, setCred] = useState<RuntimeCredentialInput>(EMPTY_CREDENTIAL);

  useEffect(() => {
    api<{ zones: ZoneListItem[] }>('/api/zone-explorer').then((r) => {
      const active = r.zones.filter((z) => z.status === 'active');
      setZones(active);
      // One account: nothing to choose.
      const ids = new Set(active.map((z) => z.accountId));
      if (ids.size === 1) setAccountId([...ids][0]);
    }).catch(() => setZones([]));
  }, []);
  // The account first, then only that account's zones: the same zone name can exist in two accounts.
  const accounts = useMemo(() => {
    const m = new Map<string, { id: string; name: string; zones: number }>();
    for (const z of zones ?? []) { const a = m.get(z.accountId) ?? { id: z.accountId, name: z.accountName || z.accountId, zones: 0 }; a.zones++; m.set(z.accountId, a); }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [zones]);
  const account = accounts.find((a) => a.id === accountId);
  const inAccount = useMemo(() => (zones ?? []).filter((z) => z.accountId === accountId).sort((a, b) => a.name.localeCompare(b.name)), [zones, accountId]);
  const listed = useMemo(() => { const q = find.trim().toLowerCase(); return q ? inAccount.filter((z) => z.name.toLowerCase().includes(q) || z.id === zoneId) : inAccount; }, [inAccount, find, zoneId]);
  const zone = inAccount.find((z) => z.id === zoneId);
  const pickAccount = (id: string) => { setAccountId(id); setZoneId(''); setFind(''); setResult(null); };
  const values = useMemo(() => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), [text]);
  const ready = !!account && !!zone && (mode === 'everything' || (values.length > 0 && values.length <= MAX)) && (direct ? credentialReady(cred) : noteReady(note, requireReason));

  const submit = async () => {
    setBusy(true);
    const cloudflare = direct ? credentialBody(cred) : undefined;
    setCred(EMPTY_CREDENTIAL);
    try {
      const r = await api<{ done?: string; approval?: { id: string } }>('/api/cloudflare/actions', { method: 'POST', json: { type: 'purge', accountId, zoneId, mode, values: mode === 'everything' ? [] : values, ...(direct ? { cloudflare } : noteBody(note)) } });
      setResult(r);
      setConfirm(false); setTyped('');
      toast(r.done ?? 'Sent to a super admin for approval', r.done ? 'ok' : 'info');
      if (r.done) setText(''); else setNote({});
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Cloudflare" title="Cache purge"
        description={direct ? 'Drop cached files at Cloudflare’s edge so visitors get the newest version from your origin. It runs with a credential you enter for this purge, never a stored token. Every purge is recorded in the audit log.'
          : 'Ask to drop cached files at Cloudflare’s edge. A super admin approves it on the Approvals page with a credential entered for it, and it runs at once.'} />
      {result && (result.done ? <Alert tone="ok" title="Purged">{result.done}. Cloudflare drops the files within a few seconds worldwide.</Alert>
        : <Alert tone="info" title="Waiting for approval">Your request is on the <Link href="/console/approvals" className="text-signal underline">Approvals</Link> page.</Alert>)}
      <Card>
        <SectionHeader step="1" title="Account" description="The Cloudflare account the zone is in." />
        <div className="px-5 py-4">
          {!zones ? <Loading label="Loading accounts"><Skeleton className="h-10 w-full max-w-md rounded-[9px]" /></Loading> : (
            <select className="input max-w-md" aria-label="Account" value={accountId} onChange={(e) => pickAccount(e.target.value)}>
              <option value="">{accounts.length ? 'Choose an account' : 'No accounts with active zones found'}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.zones} zone{a.zones === 1 ? '' : 's'})</option>)}
            </select>
          )}
        </div>
      </Card>
      <Card>
        <SectionHeader step="2" title="Zone" description={account ? `Active zones in ${account.name}.` : 'Choose the account first.'} />
        <div className="space-y-3 px-5 py-4">
          {!zones ? <Skeleton className="h-10 w-full max-w-md rounded-[9px]" /> : (
            <>
              {inAccount.length > FILTER_FROM && (
                <input className="input max-w-md" aria-label="Filter zones by name" placeholder={`Filter ${inAccount.length} zones by name`} value={find} onChange={(e) => setFind(e.target.value)} />
              )}
              <select className="input max-w-md" aria-label="Zone" value={zoneId} disabled={!account} onChange={(e) => { setZoneId(e.target.value); setResult(null); }}>
                <option value="">{!account ? 'Choose an account first' : listed.length ? 'Choose a zone' : 'No zone matches'}</option>
                {listed.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
            </>
          )}
        </div>
      </Card>
      <Card>
        <SectionHeader step="3" title="What to purge" description="Every plan can purge by URL, prefix, host or tag. Cloudflare limits how many purge requests a zone may send per second." />
        <div className="space-y-4 px-5 py-4">
          <Segmented value={mode} onChange={(m) => setMode(m)} options={MODES} />
          {mode === 'everything' ? (
            <Alert tone="warn" title="Purge everything">Every cached file of the zone is dropped. Your origin serves all of them again until they are cached anew — expect a burst of origin traffic.</Alert>
          ) : (
            <Field label={`${MODES.find((m) => m.value === mode)!.label} (${values.length} of up to ${MAX})`} htmlFor="purge-values" hint={HINT[mode]} error={values.length > MAX ? `At most ${MAX} at a time` : undefined}>
              <textarea id="purge-values" className="input min-h-[140px] font-mono !text-[12.5px]" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
            </Field>
          )}
          {!direct && <ChangeNoteFields value={note} onChange={setNote} requireReason={requireReason} />}
          {direct ? <RuntimeCredentialFields value={cred} onChange={setCred} scope="zone" purpose="purge" />
            : <p className="text-xs text-muted">Stored tokens are never used to purge: the super admin who approves enters an API token with Zone › Cache Purge › Purge, or a Global API Key, at that moment.</p>}
          <div className="flex flex-wrap items-center justify-end gap-3">
            {account && zone && <span className="text-[13px] text-muted">Purges <span className="font-medium text-ink-2">{zone.name}</span> in <span className="font-medium text-ink-2">{account.name}</span></span>}
            <Button variant="primary" disabled={!ready} onClick={() => (mode === 'everything' ? setConfirm(true) : submit())} loading={busy && !confirm} icon={<Eraser className="size-4" />}>
              {direct ? 'Purge' : 'Ask for approval'}
            </Button>
          </div>
        </div>
      </Card>
      <Modal open={confirm} onClose={() => setConfirm(false)} title={`Purge everything from ${zone?.name ?? 'the zone'}?`} description={`Account ${account?.name ?? ''}. Type the zone name to confirm.`}
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" disabled={typed.trim() !== zone?.name} loading={busy} onClick={submit}>{direct ? 'Purge everything' : 'Ask for approval'}</Button></>}>
        <input className="input font-mono" aria-label="Zone name" placeholder={zone?.name} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </Modal>
    </div>
  );
}
