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

export default function PurgePage() {
  const { can } = useMe();
  const toast = useToast();
  const [zones, setZones] = useState<ZoneListItem[] | null>(null);
  const [zoneId, setZoneId] = useState('');
  const [mode, setMode] = useState<Mode>('files');
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ done?: string; approval?: { id: string } } | null>(null);
  const direct = can('restore:approve');
  const [note, setNote] = useState<ChangeNote>({});
  const requireReason = useRequireReason();

  useEffect(() => { api<{ zones: ZoneListItem[] }>('/api/zone-explorer').then((r) => setZones(r.zones.filter((z) => z.status === 'active'))).catch(() => setZones([])); }, []);
  const zone = zones?.find((z) => z.id === zoneId);
  const values = useMemo(() => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean), [text]);
  const ready = !!zone && (mode === 'everything' || (values.length > 0 && values.length <= MAX)) && (direct || noteReady(note, requireReason));

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ done?: string; approval?: { id: string } }>('/api/cloudflare/actions', { method: 'POST', json: { type: 'purge', zoneId, mode, values: mode === 'everything' ? [] : values, ...(direct ? {} : noteBody(note)) } });
      setResult(r);
      setConfirm(false); setTyped('');
      toast(r.done ?? 'Sent to a super admin for approval', r.done ? 'ok' : 'info');
      if (r.done) setText(''); else setNote({});
    } catch (err) { toast((err as Error).message, 'bad'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Cloudflare" title="Cache purge"
        description={direct ? 'Drop cached files at Cloudflare’s edge so visitors get the newest version from your origin. Every purge is recorded in the audit log.'
          : 'Ask to drop cached files at Cloudflare’s edge. A super admin approves it on the Approvals page, and it runs at once.'} />
      {result && (result.done ? <Alert tone="ok" title="Purged">{result.done}. Cloudflare drops the files within a few seconds worldwide.</Alert>
        : <Alert tone="info" title="Waiting for approval">Your request is on the <Link href="/console/approvals" className="text-signal underline">Approvals</Link> page.</Alert>)}
      <Card>
        <SectionHeader step="1" title="Zone" />
        <div className="px-5 py-4">
          {!zones ? <Loading label="Loading zones"><Skeleton className="h-10 w-full max-w-md rounded-[9px]" /></Loading> : (
            <select className="input max-w-md" aria-label="Zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
              <option value="">{zones.length ? 'Choose a zone' : 'No active zones found'}</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}{z.accountName ? ` — ${z.accountName}` : ''}</option>)}
            </select>
          )}
        </div>
      </Card>
      <Card>
        <SectionHeader step="2" title="What to purge" description="Every plan can purge by URL, prefix, host or tag. Cloudflare limits how many purge requests a zone may send per second." />
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
          <div className="flex justify-end">
            <Button variant="primary" disabled={!ready} onClick={() => (mode === 'everything' ? setConfirm(true) : submit())} loading={busy && !confirm} icon={<Eraser className="size-4" />}>
              {direct ? 'Purge' : 'Ask for approval'}
            </Button>
          </div>
        </div>
      </Card>
      <Modal open={confirm} onClose={() => setConfirm(false)} title={`Purge everything from ${zone?.name ?? 'the zone'}?`} description="Type the zone name to confirm."
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" disabled={typed.trim() !== zone?.name} loading={busy} onClick={submit}>{direct ? 'Purge everything' : 'Ask for approval'}</Button></>}>
        <input className="input font-mono" aria-label="Zone name" placeholder={zone?.name} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </Modal>
    </div>
  );
}
