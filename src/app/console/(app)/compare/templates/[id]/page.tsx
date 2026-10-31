'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Play, RefreshCw, Save, Trash2 } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { INDEX_KINDS, TEMPLATE_MATCHES, type IndexKind, type TemplateItem, type TemplateMatch } from '@/lib/zone-index';
import type { GapsPage, Template } from '@/lib/compare';
import { Alert, Badge, Button, Card, Checkbox, Field, Loading, Modal, PageHeader, SectionHeader, SkeletonTable, cx } from '@/components/ui';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { Pager, Values } from '../../parts';

const whole = new Intl.NumberFormat();
const PAGE = 50;
const KIND_LABEL = Object.fromEntries(INDEX_KINDS.map((k) => [k.kind, k.label])) as Record<IndexKind, string>;
const MATCH_LABEL: Record<TemplateMatch, string> = { equals: 'is', contains: 'contains', present: 'exists', absent: 'does not exist' };
type Answer = GapsPage & { generatedAt: string };

export default function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useMe();
  const toast = useToast();
  const router = useRouter();
  const manage = can('zones:tag');
  const [template, setTemplate] = useState<Template | null>(null);
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [version, setVersion] = useState(0);

  const loadTemplate = useCallback(async () => {
    try { const r = await api<{ template: Template }>(`/api/compare/templates/${id}`); setTemplate(r.template); setItems(r.template.items); setError(''); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void loadTemplate(); }, [loadTemplate]);

  const dirty = !!template && JSON.stringify(items) !== JSON.stringify(template.items);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ template: Template }>(`/api/compare/templates/${id}`, { method: 'PUT', json: { items } });
      setTemplate(r.template); setItems(r.template.items); setVersion((v) => v + 1);
      toast('Template saved — the gaps are being computed again');
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setSaving(false); }
  };
  const remove = async () => {
    try { await api(`/api/compare/templates/${id}`, { method: 'DELETE' }); toast('Template deleted'); router.push('/console/compare/templates'); } catch (e) { toast((e as Error).message, 'bad'); }
  };

  if (error && !template) return <Alert tone="bad" title="The template could not be read">{error}</Alert>;
  if (!template) return <Loading label="Loading the template"><SkeletonTable rows={6} cols={4} /></Loading>;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Template" title={template.name}
        description={<>{template.description || 'A baseline of expected values.'} {template.sourceZoneName && <span className="text-faint">Made from {template.sourceZoneName}; changed {relTime(template.updatedAt)} by {template.updatedBy ?? 'someone'}.</span>}</>}
        actions={manage ? <Button variant="danger" onClick={() => setConfirmDelete(true)} icon={<Trash2 className="size-4" />}>Delete</Button> : undefined} />
      <Gaps id={id} items={template.items} version={version} manage={manage} />
      <Card>
        <SectionHeader title={`Expected (${whole.format(items.length)} items)`} description="Each item names the same thing in every zone; {zone} stands for the zone's own name."
          aside={manage ? <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={save} icon={<Save className="size-4" />}>Save</Button> : undefined} />
        <ItemTable items={items} manage={manage} onChange={setItems} />
      </Card>
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete “${template.name}”?`} description="The template and its kept results go. Zones are not changed."
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="danger" onClick={remove}>Delete</Button></>}>
        <p className="text-sm text-muted">This cannot be undone.</p>
      </Modal>
    </div>
  );
}

function ItemTable({ items, manage, onChange }: { items: TemplateItem[]; manage: boolean; onChange: (items: TemplateItem[]) => void }) {
  const [offset, setOffset] = useState(0);
  const shown = items.slice(offset, offset + PAGE);
  const set = (i: number, patch: Partial<TemplateItem>) => onChange(items.map((x, j) => (j === offset + i ? { ...x, ...patch } : x)));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-muted">
            {['What', 'Rule', 'Expected', ''].map((h, i) => <th key={i} scope="col" className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map((t, i) => (
            <tr key={t.item} className="border-b border-line/60 align-top last:border-0">
              <td className="max-w-[340px] px-4 py-2"><Badge className="mr-1.5">{KIND_LABEL[t.kind] ?? t.kind}</Badge><span className="break-words text-ink-2">{t.path}</span></td>
              <td className="px-4 py-2">
                {manage ? (
                  <select className="input !py-1 !text-[12.5px]" aria-label={`Rule for ${t.path}`} value={t.match} onChange={(e) => set(i, { match: e.target.value as TemplateMatch })}>
                    {TEMPLATE_MATCHES.map((m) => <option key={m} value={m}>{MATCH_LABEL[m]}</option>)}
                  </select>
                ) : MATCH_LABEL[t.match]}
              </td>
              <td className="w-[40%] px-4 py-2">
                {t.match === 'present' || t.match === 'absent' ? <span className="text-faint">—</span>
                  : manage ? <input className="input !py-1 font-mono !text-[12px]" aria-label={`Expected value of ${t.path}`} value={t.expected} maxLength={4000} onChange={(e) => set(i, { expected: e.target.value })} />
                    : <Values v={[t.expected]} />}
              </td>
              <td className="px-4 py-2 text-right">
                {manage && <Button size="sm" variant="ghost" aria-label={`Remove ${t.path}`} onClick={() => onChange(items.filter((_, j) => j !== offset + i))} icon={<Trash2 className="size-3.5" />} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager offset={offset} limit={PAGE} shown={shown.length} total={items.length} onPage={setOffset} />
    </div>
  );
}

function Gaps({ id, items, version, manage }: { id: string; items: TemplateItem[]; version: number; manage: boolean }) {
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const [account, setAccount] = useState('');
  const [tag, setTag] = useState('');
  const [onlyGaps, setOnlyGaps] = useState(true);
  const [filters, setFilters] = useState({ account: '', tag: '' });
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const u = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
    if (filters.account) u.set('account', filters.account);
    if (filters.tag) u.set('tag', filters.tag);
    if (onlyGaps) u.set('gaps', '1');
    try { setData(await api<Answer>(`/api/compare/templates/${id}/gaps?${u}`)); setError(''); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [id, offset, filters, onlyGaps]);
  useEffect(() => { void load(); }, [load, version]);

  const recompute = async () => {
    try { await api(`/api/compare/templates/${id}/compute`, { method: 'POST' }); toast('Computing the gaps again in the background — press Refresh to see them', 'info'); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const s = data?.summary;
  const job = data?.computing;
  return (
    <Card>
      <SectionHeader title={s ? `${whole.format(s.withGaps)} of ${whole.format(s.zones)} zones have gaps` : 'Gaps per zone'}
        description={s?.computedAt ? `Computed ${relTime(s.computedAt)} from stored data${s.stale ? ' — older than the template or the index: being computed again' : ''}.` : 'Not computed yet.'}
        aside={<div className="flex items-center gap-2">
          {data && <span className="text-[12px] text-faint" title={fmtDate(data.generatedAt)}>As of {new Date(data.generatedAt).toLocaleTimeString()}</span>}
          <Button size="sm" variant="ghost" loading={loading} onClick={load} icon={<RefreshCw className="size-3.5" />}>Refresh</Button>
          {manage && <Button size="sm" onClick={recompute} icon={<Play className="size-3.5" />}>Recompute</Button>}
        </div>} />
      {job && !job.error && <p className="border-b border-line px-5 py-2 text-[12px] text-info">Computing: {whole.format(job.done)} of {whole.format(job.total)} zones (press Refresh to update)</p>}
      {job?.error && <p className="border-b border-line px-5 py-2 text-[12px] text-bad">The last computation failed: {job.error}</p>}
      <form className="grid gap-3 border-b border-line px-5 py-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); setOffset(0); setFilters({ account: account.trim(), tag: tag.trim() }); }}>
        <Field label="Account ID" optional><input className="input font-mono" value={account} maxLength={64} onChange={(e) => setAccount(e.target.value)} placeholder="All accounts" /></Field>
        <Field label="Zone tags" optional><input className="input" value={tag} maxLength={300} onChange={(e) => setTag(e.target.value)} placeholder="All zones" /></Field>
        <Checkbox label="Only zones with gaps" checked={onlyGaps} onChange={(v) => { setOnlyGaps(v); setOffset(0); }} />
        <Button type="submit" size="sm">Filter</Button>
      </form>
      {error ? <p className="px-5 py-6 text-sm text-bad">{error}</p> : !data ? <div className="p-5"><SkeletonTable rows={5} cols={3} /></div> : !data.zones.length ? (
        <p className="px-5 py-8 text-center text-sm text-muted">{s?.zones ? 'No zone here has gaps.' : 'No results yet: they are computed from the search index (press Refresh in a moment).'}</p>
      ) : (
        <ul>
          {data.zones.map((z) => (
            <li key={z.zoneId} className="border-b border-line/60 last:border-0">
              <button type="button" aria-expanded={open === z.zoneId} onClick={() => setOpen(open === z.zoneId ? null : z.zoneId)}
                className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left text-[13px] hover:bg-raised/40">
                <span className="font-medium">{z.zoneName}</span>
                <span className="flex items-center gap-2">
                  {z.gaps ? <Badge tone="warn">{whole.format(z.gaps)} of {whole.format(z.checked)} differ</Badge> : <Badge tone="ok">matches</Badge>}
                  <ChevronDown className={cx('size-4 text-faint transition-transform', open === z.zoneId && 'rotate-180')} />
                </span>
              </button>
              {open === z.zoneId && (
                <div className="overflow-x-auto px-5 pb-3">
                  {!z.details.length ? <p className="text-[12.5px] text-muted">Matches every item.</p> : (
                    <table className="w-full min-w-[640px] text-left text-[12.5px]">
                      <thead><tr className="text-muted"><th scope="col" className="py-1 pr-3 font-medium">What</th><th scope="col" className="py-1 pr-3 font-medium">Expected</th><th scope="col" className="py-1 font-medium">Found</th></tr></thead>
                      <tbody>
                        {z.details.map((g) => (
                          <tr key={g.item} className="align-top">
                            <td className="py-1 pr-3 text-ink-2">{g.path} <Badge tone={g.problem === 'different' ? 'warn' : 'bad'}>{g.problem}</Badge></td>
                            <td className="max-w-[320px] py-1 pr-3">{g.match === 'present' || g.match === 'absent' ? <span className="text-muted">{MATCH_LABEL[g.match]}</span> : <Values v={[`${g.match === 'contains' ? '… ' : ''}${g.expected}`]} />}</td>
                            <td className="max-w-[320px] py-1"><Values v={g.actual} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {z.gaps > z.details.length && <p className="mt-1 text-xs text-muted">and {whole.format(z.gaps - z.details.length)} more</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && <Pager offset={data.offset} limit={data.limit} shown={data.zones.length} total={data.total} onPage={setOffset} />}
      {!items.length && <p className="px-5 py-3 text-xs text-warn">This template has no items.</p>}
    </Card>
  );
}
