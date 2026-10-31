'use client';

import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '@/lib/client';
import { Alert, Button, Checkbox, Field, Modal, Segmented } from '@/components/ui';
import { SECTIONS, WEEKDAYS, nextRunAt, type Cadence, type ReportChannel, type ReportDefinition, type ReportScope, type SectionKey } from '@/lib/report-types';

// The form for a new report or a changed one (a dialog on the Reports pages).

export interface ReportOptions { accounts: { id: string; name: string; zones: number }[]; tags: { tag: string; count: number }[]; channels: { slack: boolean; webhook: boolean } }

const HOURS = Array.from({ length: 24 }, (_, h) => h);

interface Props { open: boolean; onClose: () => void; initial: ReportDefinition | null; onSaved: (d: ReportDefinition) => void }

/** Mounted only while open, so the form starts from `initial` every time. */
export function ReportEditor(p: Props) {
  return p.open ? <EditorDialog {...p} /> : null;
}

function EditorDialog({ open, onClose, initial, onSaved }: Props) {
  const [opts, setOpts] = useState<ReportOptions | null>(null);
  const [optsError, setOptsError] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [scope, setScope] = useState<ReportScope>(initial?.scope ?? 'all');
  const [accounts, setAccounts] = useState<string[]>(initial?.accounts ?? []);
  const [accountQuery, setAccountQuery] = useState('');
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [cadence, setCadence] = useState<Cadence>(initial?.cadence ?? 'weekly');
  const [weekday, setWeekday] = useState(initial?.weekday ?? 1);
  const [hour, setHour] = useState(initial?.hour ?? 7);
  const [sections, setSections] = useState<SectionKey[]>(initial?.sections ?? SECTIONS.map((s) => s.key));
  const [channels, setChannels] = useState<ReportChannel[]>(initial?.channels ?? []);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<ReportOptions>('/api/reports/options').then(setOpts, (e) => setOptsError((e as Error).message));
  }, []);

  const shown = useMemo(() => {
    const q = accountQuery.trim().toLowerCase();
    const list = opts?.accounts ?? [];
    return (q ? list.filter((a) => a.name.toLowerCase().includes(q) || a.id.includes(q)) : list).slice(0, 200);
  }, [opts, accountQuery]);
  const next = nextRunAt(cadence, hour, cadence === 'weekly' ? weekday : null, new Date());

  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  const save = async () => {
    setSaving(true); setError('');
    try {
      const body = { name, scope, accounts, tags: tags.split(/[,;\s]+/).filter(Boolean), cadence, weekday: cadence === 'weekly' ? weekday : null, hour, sections, channels, enabled };
      const r = initial
        ? await api<{ definition: ReportDefinition }>(`/api/reports/${initial.id}`, { method: 'PUT', json: body })
        : await api<{ definition: ReportDefinition }>('/api/reports', { method: 'POST', json: body });
      onSaved(r.definition);
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} width="max-w-2xl" title={initial ? 'Change report' : 'New report'}
      description="Made by the worker at its time (UTC) from stored monitoring data, the Cloudflare audit logs and account traffic totals."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} onClick={save} icon={<Save className="size-4" />}>Save</Button></>}>
      <div className="space-y-5">
        {error && <Alert tone="bad">{error}</Alert>}
        <Field label="Name"><input className="input w-full" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Weekly security summary" /></Field>

        <Field label="Covers">
          <Segmented value={scope} onChange={setScope} options={[{ value: 'all', label: 'Everything' }, { value: 'accounts', label: 'Accounts' }, { value: 'tag', label: 'Zone tags' }]} />
        </Field>
        {scope === 'accounts' && (
          <div className="space-y-2">
            {optsError && <Alert tone="warn">{optsError}</Alert>}
            <Field label="Find an account" hint={`${accounts.length} chosen · accounts monitoring has listed`}>
              <input className="input w-full" value={accountQuery} onChange={(e) => setAccountQuery(e.target.value)} placeholder="Name or account ID" />
            </Field>
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line p-2" aria-label="Accounts">
              {shown.map((a) => (
                <li key={a.id}><Checkbox checked={accounts.includes(a.id)} onChange={(v) => setAccounts((l) => toggle(l, a.id, v))} label={`${a.name} (${a.zones.toLocaleString()} zones)`} /></li>
              ))}
              {opts && !shown.length && <li className="px-1 text-[13px] text-muted">No account matches.</li>}
              {!opts && !optsError && <li className="px-1 text-[13px] text-muted">Loading accounts…</li>}
            </ul>
          </div>
        )}
        {scope === 'tag' && (
          <Field label="Zones with every one of these tags" hint={opts?.tags.length ? `Known tags: ${opts.tags.slice(0, 12).map((t) => t.tag).join(', ')}${opts.tags.length > 12 ? ', …' : ''}` : 'Separate tags with commas'}>
            <input className="input w-full font-mono" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="env:prod, team:payments" />
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="How often">
            <Segmented value={cadence} onChange={setCadence} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]} />
          </Field>
          {cadence === 'weekly' && (
            <Field label="Day">
              <select className="input w-full" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </Field>
          )}
          <Field label="Hour (UTC)">
            <select className="input w-full" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </Field>
        </div>
        <p className="-mt-2 text-xs text-muted">Next: {next.toISOString().slice(0, 16).replace('T', ' ')} UTC ({next.toLocaleString()} your time). It covers the {cadence === 'daily' ? '24 hours' : '7 days'} before.</p>

        <Field label="Sections">
          <ul className="space-y-1.5">
            {SECTIONS.map((s) => (
              <li key={s.key}>
                <Checkbox checked={sections.includes(s.key)} onChange={(v) => setSections((l) => toggle(l, s.key, v))} label={s.label} />
                <p className="ml-6 text-xs text-muted">{s.description}</p>
              </li>
            ))}
          </ul>
        </Field>

        <Field label="Send to" hint="The addresses set in Monitoring › Settings. Each report is sent once per channel and never again, even when a send fails. Leave both off to keep reports in the console only (download them as HTML or CSV).">
          <div className="flex flex-wrap gap-4">
            <Checkbox checked={channels.includes('slack')} onChange={(v) => setChannels((l) => toggle(l, 'slack' as ReportChannel, v))} label={`Slack${opts && !opts.channels.slack ? ' (not set up)' : ''}`} />
            <Checkbox checked={channels.includes('webhook')} onChange={(v) => setChannels((l) => toggle(l, 'webhook' as ReportChannel, v))} label={`Webhook${opts && !opts.channels.webhook ? ' (not set up)' : ''}`} />
          </div>
        </Field>
        <Checkbox checked={enabled} onChange={setEnabled} label="On schedule (turn off to make it only by hand)" />
      </div>
    </Modal>
  );
}
