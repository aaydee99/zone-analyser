'use client';

import { useState } from 'react';
import { Pencil, Tag } from 'lucide-react';
import { api } from '@/lib/client';
import { MAX_CONTACT, MAX_NOTES, MAX_OWNER, parseTags, type ZoneMeta } from '@/lib/zone-meta-types';
import { Button, Field, Modal } from '@/components/ui';
import { TagChips, knownTags } from '@/components/tag-filter';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';

// The open zone's console tags, owner, contact and notes, and (with zones:tag) the form to change
// them. Console data only: nothing here is sent to Cloudflare.

export function ZoneMetaPanel({ zoneId, zoneName, meta, onSaved, onPickTag }: {
  zoneId: string; zoneName: string; meta: ZoneMeta | null; onSaved: (m: ZoneMeta) => void; onPickTag: (tag: string) => void;
}) {
  const { can } = useMe();
  const toast = useToast();
  const editable = can('zones:tag');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ tags: '', owner: '', contact: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const parsed = parseTags(form.tags);
  const start = () => {
    setForm({ tags: (meta?.tags ?? []).join(', '), owner: meta?.owner ?? '', contact: meta?.contact ?? '', notes: meta?.notes ?? '' });
    setOpen(true);
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ meta: ZoneMeta }>('/api/zones/meta', { method: 'PUT', json: { zoneId, tags: parsed.tags, owner: form.owner, contact: form.contact, notes: form.notes } });
      onSaved(r.meta);
      void knownTags(true).catch(() => {});
      toast('Tags and owner saved');
      setOpen(false);
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  const has = !!meta && (meta.tags.length > 0 || !!meta.owner || !!meta.contact || !!meta.notes);
  return (
    <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-line/60 pt-3 text-[13px]">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <Tag className="size-3.5 shrink-0 text-faint" aria-hidden />
        {meta?.tags.length ? <TagChips tags={meta.tags} max={30} onPick={onPickTag} /> : <span className="text-xs text-faint">No tags</span>}
      </div>
      {has && (
        <dl className="flex flex-wrap gap-x-5 gap-y-1">
          {meta!.owner && <div><dt className="inline text-xs text-muted">Owner </dt><dd className="inline text-ink-2">{meta!.owner}</dd></div>}
          {meta!.contact && <div><dt className="inline text-xs text-muted">Contact </dt><dd className="inline break-all text-ink-2">{meta!.contact}</dd></div>}
        </dl>
      )}
      {editable && <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={start}>Edit tags</Button>}
      {meta?.notes && <p className="w-full text-xs whitespace-pre-wrap text-muted">{meta.notes}</p>}
      <Modal open={open} onClose={() => setOpen(false)} title={`Tags and owner of ${zoneName}`} description="Kept in the console only — never sent to Cloudflare. Every change is in the audit log."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={parsed.bad.length > 0 || parsed.tags.length > 30} onClick={save}>Save</Button></>}>
        <div className="space-y-4">
          <Field label="Tags" hint={parsed.bad.length ? undefined : 'Separated by commas or spaces, e.g. team:payments, env:prod, tier:critical'}
            error={parsed.bad.length ? `Not a tag: ${parsed.bad.join(', ')} — letters, digits and : . _ / -` : parsed.tags.length > 30 ? 'At most 30 tags' : undefined}>
            <input className="input font-mono !text-[13px]" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} autoFocus />
          </Field>
          <Field label="Owner" optional><input className="input" maxLength={MAX_OWNER} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="Payments team" /></Field>
          <Field label="Contact" optional><input className="input" maxLength={MAX_CONTACT} value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} placeholder="payments-oncall@example.com" /></Field>
          <Field label="Notes" optional><textarea className="input min-h-[80px]" maxLength={MAX_NOTES} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}
