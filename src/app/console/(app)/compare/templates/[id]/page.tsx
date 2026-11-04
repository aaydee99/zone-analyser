'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Play, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { CHECK_MATCHES, INDEX_KINDS, MATCH_TEXT, MAX_CHECK_CONDITIONS, TEMPLATE_MATCHES, type CheckMatch, type CheckWhen, type IndexKind, type TemplateItem, type TemplateMatch } from '@/lib/zone-index';
import { LIBRARIES, PHASES, PHASE_LABEL, RULE_FIELDS, SETTING_IDS } from '@/lib/template-library';
import type { GapsPage, Template } from '@/lib/compare';
import { Alert, Badge, Button, Card, Checkbox, Field, Loading, Modal, PageHeader, SectionHeader, SkeletonTable, cx } from '@/components/ui';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { Pager, Values } from '../../parts';
import { AccountPicker, ZonePicker, type PickedAccount, type PickedZone } from '../../../investigate/shared';

import { whole } from '@/lib/num';
const PAGE = 50;
const KIND_LABEL = Object.fromEntries(INDEX_KINDS.map((k) => [k.kind, k.label])) as Record<IndexKind, string>;
const MATCH_LABEL = MATCH_TEXT;
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
      {manage && <AddItems items={items} onAdd={(add) => setItems((l) => [...l, ...add.filter((x) => !l.some((y) => y.item === x.item))])} />}
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete “${template.name}”?`} description="The template and its kept results go. Zones are not changed."
        footer={<><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="danger" onClick={remove}>Delete</Button></>}>
        <p className="text-sm text-muted">This cannot be undone.</p>
      </Modal>
    </div>
  );
}

const PRESENCE: TemplateMatch[] = ['present', 'absent'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'item';
/** The template's key for a new item, not taken yet. */
function freeKey(base: string, taken: Set<string>) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** What an item checks, in words. */
function ItemExpected({ t }: { t: TemplateItem }) {
  if (t.check) {
    return (
      <div className="text-[12px]">
        <div className="text-muted">{t.match === 'absent' ? 'No rule' : 'A rule'} in {PHASE_LABEL[t.check.phase] ?? t.check.phase} where</div>
        <ul className="mt-0.5 space-y-0.5">{t.check.when.map((w, i) => <li key={i} className="font-mono break-words [overflow-wrap:anywhere] text-ink-2">{w.field} <span className="text-muted">{MATCH_TEXT[w.match]}</span> {w.value}</li>)}</ul>
      </div>
    );
  }
  if (t.match === 'present' || t.match === 'absent') return <span className="text-faint">—</span>;
  return <span className="font-mono text-[12px] break-words [overflow-wrap:anywhere]"><span className="text-muted">{MATCH_TEXT[t.match]}</span> {t.expected}</span>;
}

/** Add items by hand: from the best-practice library, or any setting, rule check or stored item. */
function AddItems({ items, onAdd }: { items: TemplateItem[]; onAdd: (add: TemplateItem[]) => void }) {
  const [tab, setTab] = useState<'library' | 'custom'>('library');
  return (
    <Card>
      <SectionHeader title="Add items" description="Pick best-practice items or define your own: zone settings, custom rules, rate limiting, managed rules and OWASP, cache rules, headers, redirects, or any stored item. They are checked against every zone; nothing is written to Cloudflare. Save to keep them." />
      <div className="flex gap-1 border-b border-line px-5" role="tablist">
        {([['library', 'Best-practice library'], ['custom', 'Custom item']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cx('-mb-px border-b-2 px-3 py-2 text-[13px] font-medium', tab === k ? 'border-signal text-ink' : 'border-transparent text-muted hover:text-ink')}>{label}</button>
        ))}
      </div>
      {tab === 'library' ? <Library items={items} onAdd={onAdd} /> : <CustomItem items={items} onAdd={onAdd} />}
    </Card>
  );
}

function Library({ items, onAdd }: { items: TemplateItem[]; onAdd: (add: TemplateItem[]) => void }) {
  const have = new Set(items.map((i) => i.item));
  const [libId, setLibId] = useState(LIBRARIES[0].id);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const lib = LIBRARIES.find((l) => l.id === libId)!;
  const term = q.trim().toLowerCase();
  const shown = lib.entries.filter((e) => !term || `${e.title} ${e.why} ${e.group} ${e.item.check ? JSON.stringify(e.item.check.when) : `${e.item.item} ${e.item.expected}`}`.toLowerCase().includes(term));
  const groups = [...new Set(shown.map((e) => e.group))];
  const free = shown.filter((e) => !have.has(e.item.item));
  const toggle = (ids: string[], on: boolean) => setPicked((p) => (on ? [...new Set([...p, ...ids])] : p.filter((y) => !ids.includes(y))));
  const add = () => { onAdd(LIBRARIES.flatMap((l) => l.entries).filter((e) => picked.includes(e.id)).map((e) => e.item)); setPicked([]); };
  return (
    <div className="space-y-4 px-5 py-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Library">
        {LIBRARIES.map((l) => (
          <button key={l.id} type="button" aria-pressed={l.id === libId} onClick={() => setLibId(l.id)}
            className={cx('rounded-lg border px-3 py-1.5 text-[12.5px]', l.id === libId ? 'border-signal bg-signal/10 text-ink' : 'border-line text-muted hover:text-ink')}>
            {l.name} <span className="text-faint">({l.entries.length.toLocaleString('en-US')})</span>
          </button>
        ))}
      </div>
      <p className="text-[12.5px] text-muted">{lib.description}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[14rem] flex-1"><Field label="Search the library" optional><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="POL-1010, bot score, OWASP, TLS, /login" /></Field></div>
        <Button size="sm" variant="primary" disabled={!picked.length} onClick={add} icon={<Plus className="size-3.5" />}>Add {picked.length ? picked.length.toLocaleString('en-US') : ''} selected</Button>
        <Button size="sm" variant="ghost" disabled={!free.length} onClick={() => toggle(free.map((e) => e.id), true)}>Select all shown not added ({free.length.toLocaleString('en-US')})</Button>
        {picked.length > 0 && <Button size="sm" variant="ghost" onClick={() => setPicked([])}>Clear</Button>}
      </div>
      {!shown.length && <p className="text-[12.5px] text-muted">Nothing in this library matches “{q}”.</p>}
      <div className="space-y-5">
        {groups.map((g) => {
          const inGroup = shown.filter((e) => e.group === g);
          const freeIds = inGroup.filter((e) => !have.has(e.item.item)).map((e) => e.id);
          const allOn = freeIds.length > 0 && freeIds.every((x) => picked.includes(x));
          return (
            <section key={g}>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold tracking-wide text-muted uppercase">{g} <span className="font-normal normal-case text-faint">· {inGroup.length.toLocaleString('en-US')} checks</span></h3>
                {freeIds.length > 0 && <Button size="sm" variant="ghost" onClick={() => toggle(freeIds, !allOn)}>{allOn ? 'Unselect this group' : `Select this group (${freeIds.length.toLocaleString('en-US')})`}</Button>}
              </div>
              <ul className="divide-y divide-line/60 rounded-lg border border-line">
                {inGroup.map((e) => {
                  const added = have.has(e.item.item);
                  return (
                    <li key={e.id} className="flex gap-3 px-3 py-2.5">
                      <span className="mt-0.5 shrink-0"><Checkbox label={<span className="sr-only">{e.title}</span>} disabled={added}
                        checked={added || picked.includes(e.id)} onChange={(v) => toggle([e.id], v)} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2"><span className="text-[13px] font-medium break-words text-ink">{e.title}</span>{added && <Badge tone="ok">added</Badge>}</div>
                        <p className="text-[12px] text-muted">{e.why}{e.source && <> <a href={e.source} target="_blank" rel="noreferrer" className="text-signal hover:underline">Cloudflare docs</a></>}</p>
                        <div className="mt-1"><ItemExpected t={e.item} /></div>
                        {!e.item.check && <div className="mt-0.5 font-mono text-[11px] text-faint">{e.item.item}</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

type CustomKind = 'setting' | 'rule' | 'other';
function CustomItem({ items, onAdd }: { items: TemplateItem[]; onAdd: (add: TemplateItem[]) => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<CustomKind>('rule');
  const [label, setLabel] = useState('');
  // A setting, or any stored item.
  const [key, setKey] = useState('');
  const [itemKind, setItemKind] = useState<IndexKind>('resource');
  const [match, setMatch] = useState<TemplateMatch>('equals');
  const [value, setValue] = useState('');
  // A rule check.
  const [phase, setPhase] = useState(PHASES[0].phase);
  const [must, setMust] = useState<'present' | 'absent'>('present');
  const [when, setWhen] = useState<CheckWhen[]>([{ field: 'expression', match: 'contains', value: '' }, { field: 'action', match: 'equals', value: '' }]);
  const setW = (i: number, patch: Partial<CheckWhen>) => setWhen((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const needsValue = match !== 'present' && match !== 'absent';
  const taken = new Set(items.map((i) => i.item));

  const reset = () => { setLabel(''); setKey(''); setValue(''); setWhen([{ field: 'expression', match: 'contains', value: '' }, { field: 'action', match: 'equals', value: '' }]); };
  const add = () => {
    let item: TemplateItem;
    if (kind === 'rule') {
      const conds = when.filter((w) => w.field.trim() && w.value.trim()).map((w) => ({ ...w, field: w.field.trim() }));
      if (!conds.length) return toast('Give at least one condition with a field and a value', 'bad');
      if (conds.some((w) => w.field.includes('<'))) return toast('Replace <Header-Name> with the header’s name', 'bad');
      const p = PHASES.find((x) => x.phase === phase)!;
      const title = label.trim() || `${p.label}: ${conds.map((w) => `${w.field} ${MATCH_TEXT[w.match]} ${w.value}`).join(', ')}`;
      item = { item: freeKey(`check:${phase}:${slug(label || conds.map((w) => w.value).join(' '))}`, taken), kind: p.kind, path: title.slice(0, 300), expected: '', match: must, check: { phase, when: conds } };
    } else {
      const k = kind === 'setting' ? `setting:${key.trim()}` : key.trim();
      if (!key.trim()) return toast(kind === 'setting' ? 'Give the setting ID' : 'Give the item key', 'bad');
      if (taken.has(k)) return toast('That item is in the template already: change it in the list below', 'bad');
      if (needsValue && !value.trim()) return toast('Give the expected value', 'bad');
      item = { item: k, kind: kind === 'setting' ? 'setting' : itemKind, path: (label.trim() || (kind === 'setting' ? `Setting ${key.trim()}` : k)).slice(0, 300), expected: needsValue ? value : '', match };
    }
    onAdd([item]); reset(); toast('Added — Save to keep it', 'info');
  };

  return (
    <div className="space-y-4 px-5 py-4">
      <Field label="What to check">
        <div className="flex flex-wrap gap-2">
          {([['rule', 'A rule (custom, rate limiting, managed, OWASP, cache, headers, redirects)'], ['setting', 'A zone setting'], ['other', 'Any stored item']] as const).map(([k, l]) => (
            <button key={k} type="button" onClick={() => { setKind(k); setMatch(k === 'other' ? 'present' : 'equals'); }}
              className={cx('rounded-lg border px-3 py-1.5 text-[12.5px]', kind === k ? 'border-signal bg-signal/10 text-ink' : 'border-line text-muted hover:text-ink')}>{l}</button>
          ))}
        </div>
      </Field>
      <Field label="Name" optional hint="How it is shown in the list and the gaps."><input className="input" value={label} maxLength={300} onChange={(e) => setLabel(e.target.value)} placeholder={kind === 'rule' ? 'Block access to /wp-login.php' : 'Minimum TLS 1.2'} /></Field>
      {kind === 'rule' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Where"><select className="input" value={phase} onChange={(e) => setPhase(e.target.value)}>{PHASES.map((p) => <option key={p.phase} value={p.phase}>{p.label}</option>)}</select></Field>
            <Field label="Expect"><select className="input" value={must} onChange={(e) => setMust(e.target.value as 'present' | 'absent')}><option value="present">A rule that meets every condition exists</option><option value="absent">No rule meets every condition</option></select></Field>
          </div>
          <Field label="Conditions" hint="Fields as Cloudflare names them in the rule (see the suggestions); [*] is any position in a list, e.g. action_parameters.overrides.rules[*].score_threshold. Any rule of the phase may meet them, wherever it sits.">
            <div className="space-y-2">
              {when.map((w, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto]">
                  <input className="input font-mono !text-[12px]" list="tmpl-rule-fields" aria-label={`Field ${i + 1}`} value={w.field} maxLength={200} onChange={(e) => setW(i, { field: e.target.value })} placeholder="expression" />
                  <select className="input !text-[12.5px]" aria-label={`Comparison ${i + 1}`} value={w.match} onChange={(e) => setW(i, { match: e.target.value as CheckMatch })}>{CHECK_MATCHES.map((m) => <option key={m} value={m}>{MATCH_TEXT[m]}</option>)}</select>
                  <input className="input font-mono !text-[12px]" aria-label={`Value ${i + 1}`} value={w.value} maxLength={4000} onChange={(e) => setW(i, { value: e.target.value })} placeholder={w.match === 'one_of' ? 'block, managed_challenge' : w.field === 'action' ? 'block' : '/login'} />
                  <Button size="sm" variant="ghost" aria-label={`Remove condition ${i + 1}`} disabled={when.length === 1} onClick={() => setWhen((l) => l.filter((_, j) => j !== i))} icon={<Trash2 className="size-3.5" />} />
                </div>
              ))}
              <Button size="sm" variant="ghost" disabled={when.length >= MAX_CHECK_CONDITIONS} onClick={() => setWhen((l) => [...l, { field: '', match: 'equals', value: '' }])} icon={<Plus className="size-3.5" />}>Add condition</Button>
              <datalist id="tmpl-rule-fields">{RULE_FIELDS.map((f) => <option key={f} value={f} />)}</datalist>
            </div>
          </Field>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {kind === 'setting'
              ? <Field label="Setting ID" hint="As Cloudflare names it, for example ssl, min_tls_version or always_use_https (see the suggestions)."><input className="input font-mono" list="tmpl-settings" value={key} maxLength={100} onChange={(e) => setKey(e.target.value)} placeholder="min_tls_version" /><datalist id="tmpl-settings">{SETTING_IDS.map((s) => <option key={s} value={s} />)}</datalist></Field>
              : <Field label="Item key" hint="As Search and Compare show it, for example dns:A:www, pagerule:url:{zone}/old/*:forwarding_url or bot_management:-:fight_mode."><input className="input font-mono" value={key} maxLength={300} onChange={(e) => setKey(e.target.value)} placeholder="dns:CAA:@" /></Field>}
            {kind === 'other' && <Field label="Kind"><select className="input" value={itemKind} onChange={(e) => setItemKind(e.target.value as IndexKind)}>{INDEX_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></Field>}
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Field label="Expect"><select className="input" value={match} onChange={(e) => setMatch(e.target.value as TemplateMatch)}>{TEMPLATE_MATCHES.map((m) => <option key={m} value={m}>{MATCH_TEXT[m]}</option>)}</select></Field>
            {needsValue && <Field label="Value" hint={match === 'one_of' ? 'Separate the values with commas' : match === 'at_least' || match === 'at_most' ? 'A number or a version (1.2)' : '{zone} stands for each zone’s own name'}><input className="input font-mono" value={value} maxLength={4000} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'setting' ? '1.2' : ''} /></Field>}
          </div>
        </>
      )}
      <Button variant="primary" size="sm" onClick={add} icon={<Plus className="size-3.5" />}>Add to the template</Button>
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
                    {(t.check ? PRESENCE : TEMPLATE_MATCHES).map((m) => <option key={m} value={m}>{t.check ? (m === 'present' ? 'a rule exists' : 'no rule exists') : MATCH_LABEL[m]}</option>)}
                  </select>
                ) : MATCH_LABEL[t.match]}
              </td>
              <td className="w-[40%] px-4 py-2">
                {t.check || t.match === 'present' || t.match === 'absent' ? <ItemExpected t={t} />
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
  // Empty account and zone: every account and every zone.
  const [account, setAccount] = useState<PickedAccount | null>(null);
  const [zone, setZone] = useState<PickedZone | null>(null);
  const [tag, setTag] = useState('');
  const [onlyGaps, setOnlyGaps] = useState(true);
  const [filters, setFilters] = useState({ tag: '' });
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const u = new URLSearchParams({ offset: String(offset), limit: String(PAGE) });
    if (account) u.set('account', account.id);
    if (zone) u.set('zone', zone.id);
    if (filters.tag) u.set('tag', filters.tag);
    if (onlyGaps) u.set('gaps', '1');
    try { setData(await api<Answer>(`/api/compare/templates/${id}/gaps?${u}`)); setError(''); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [id, offset, filters, onlyGaps, account, zone]);
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
      <form className="grid gap-3 border-b border-line px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] md:items-end" onSubmit={(e) => { e.preventDefault(); setOffset(0); setFilters({ tag: tag.trim() }); }}>
        <AccountPicker label="Account" value={account} onChange={(a) => { setAccount(a); setZone(null); setOffset(0); }} placeholder="All accounts — type to search" />
        <ZonePicker label="Zone" value={zone} onChange={(z) => { setZone(z); setOffset(0); }} accountId={account?.id} placeholder={account ? `All zones of ${account.name}` : 'All zones — type to search'} />
        <Field label="Zone tags" optional><input className="input" value={tag} maxLength={300} onChange={(e) => setTag(e.target.value)} placeholder="Any tag" /></Field>
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
                            <td className="max-w-[320px] py-1 pr-3">{g.item.startsWith('check:') ? <Values v={[`${g.match === 'absent' ? 'No rule where' : 'A rule where'} ${g.expected}`]} /> : g.match === 'present' || g.match === 'absent' ? <span className="text-muted">{MATCH_LABEL[g.match]}</span> : <Values v={[`${MATCH_LABEL[g.match]} ${g.expected}`]} />}</td>
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
