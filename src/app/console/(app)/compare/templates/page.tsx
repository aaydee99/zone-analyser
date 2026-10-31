'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutTemplate, Plus, RefreshCw } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { INDEX_KINDS, type IndexKind } from '@/lib/zone-index';
import type { Template } from '@/lib/compare';
import { Alert, Button, Card, Checkbox, EmptyState, Field, Loading, Modal, PageHeader, SkeletonTable } from '@/components/ui';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { useSnapshot } from '../../monitoring/use-run';
import { ZonePicker } from '../parts';

type Row = Omit<Template, 'items'> & { itemCount: number };
const DEFAULT_KINDS: IndexKind[] = ['setting', 'rule', 'header', 'redirect'];

export default function TemplatesPage() {
  const { can } = useMe();
  const { data, error, loading, reload } = useSnapshot<{ templates: Row[]; generatedAt: string }>('/api/compare/templates');
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Compare" title="Templates"
        description="A template is a named baseline — the settings, rules and records every zone of a kind should have — made from a zone you trust and then edited. Each zone's gaps against it are computed from stored data. Nothing is applied to Cloudflare."
        actions={<>
          <Button variant="ghost" loading={loading && !!data} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {can('zones:tag') && <Button variant="primary" onClick={() => setOpen(true)} icon={<Plus className="size-4" />}>New template</Button>}
        </>} />
      {error && <Alert tone="bad" title="Templates could not be read">{error}</Alert>}
      {!data ? <Loading label="Loading templates"><SkeletonTable rows={4} cols={4} /></Loading> : !data.templates.length ? (
        <Card><EmptyState icon={<LayoutTemplate className="size-5" />} title="No templates yet" description={can('zones:tag') ? 'Make one from a zone whose configuration is the way it should be.' : 'An admin can make one from a zone whose configuration is the way it should be.'} /></Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.templates.map((t) => (
            <li key={t.id}>
              <Link href={`/console/compare/templates/${t.id}`} className="panel flex h-full flex-col gap-1.5 px-5 py-4 transition-colors hover:border-line-strong">
                <span className="text-[14.5px] font-semibold">{t.name}</span>
                {t.description && <span className="line-clamp-2 text-[12.5px] text-muted">{t.description}</span>}
                <span className="mt-auto pt-1 text-[11.5px] text-faint" title={fmtDate(t.updatedAt)}>{t.itemCount} items{t.sourceZoneName ? ` · from ${t.sourceZoneName}` : ''} · changed {relTime(t.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {open && <CreateTemplate onClose={() => setOpen(false)} />}
    </div>
  );
}

function CreateTemplate({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [zone, setZone] = useState<{ id: string; name: string } | null>(null);
  const [kinds, setKinds] = useState<IndexKind[]>(DEFAULT_KINDS);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ template: Template }>('/api/compare/templates', { method: 'POST', json: { name, description, zoneId: zone?.id, kinds } });
      toast(`Template “${r.template.name}” made with ${r.template.items.length} items`);
      router.push(`/console/compare/templates/${r.template.id}`);
    } catch (e) { toast((e as Error).message, 'bad'); setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title="New template" description="Start from a zone's stored configuration, then edit the expected values on the next page." width="max-w-xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!name.trim() || !zone || !kinds.length} onClick={save}>Make template</Button></>}>
      <div className="space-y-4">
        <Field label="Name"><input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Production web zones" /></Field>
        <Field label="Description" optional><input className="input" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} /></Field>
        <ZonePicker label="Start from zone" value={zone} onChange={setZone} />
        <Field label="What to include">
          <div className="grid gap-2 sm:grid-cols-2">
            {INDEX_KINDS.map((k) => (
              <Checkbox key={k.kind} label={k.label} checked={kinds.includes(k.kind)} onChange={(v) => setKinds((list) => (v ? [...list, k.kind] : list.filter((x) => x !== k.kind)))} />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
