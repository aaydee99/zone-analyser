'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, RefreshCw } from 'lucide-react';
import { api, fmtDate } from '@/lib/client';
import { INDEX_KINDS, MATCH_TEXT, type Gap, type IndexKind, type TemplateItem } from '@/lib/zone-index';
import type { Template } from '@/lib/compare';
import { PHASE_LABEL } from '@/lib/template-library';
import { Alert, Badge, Button, Card, Field, Loading, PageHeader, SectionHeader, SkeletonTable, Stat, cx } from '@/components/ui';
import { Values } from '../../../../parts';

// One zone against a template: every difference, computed now from the zone's stored configuration,
// with what was expected, what was found, and (for a rule check) the closest rule and what it lacks.

interface Answer { template: { id: string; name: string }; zone: { id: string; name: string }; gaps: Gap[]; checked: number; generatedAt: string }
type Problem = Gap['problem'] | 'all';
const PROBLEM_TEXT: Record<Gap['problem'], string> = { missing: 'missing', different: 'different', unexpected: 'should not exist' };
const KIND_LABEL = Object.fromEntries(INDEX_KINDS.map((k) => [k.kind, k.label])) as Record<IndexKind, string>;

/** What the item expects, in words. */
function expectedText(g: Gap, t: TemplateItem | undefined): string {
  if (t?.check) return `${t.match === 'absent' ? 'No rule' : 'A rule'} in ${PHASE_LABEL[t.check.phase] ?? t.check.phase} where ${t.check.when.map((w) => `${w.field} ${MATCH_TEXT[w.match]} ${w.value}`).join(' · ')}`;
  if (g.match === 'present' || g.match === 'absent') return MATCH_TEXT[g.match];
  return `${MATCH_TEXT[g.match]} ${g.expected}`;
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);

export default function TemplateZonePage({ params }: { params: Promise<{ id: string; zoneId: string }> }) {
  const { id, zoneId } = use(params);
  const [data, setData] = useState<Answer | null>(null);
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<Problem>('all');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [z, t] = await Promise.all([api<Answer>(`/api/compare/templates/${id}/zones/${zoneId}`), api<{ template: Template }>(`/api/compare/templates/${id}`)]);
      setData(z); setItems(t.template.items); setError('');
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [id, zoneId]);
  useEffect(() => { void load(); }, [load]);

  const byItem = useMemo(() => new Map(items.map((i) => [i.item, i])), [items]);
  const counts = useMemo(() => {
    const c = { missing: 0, different: 0, unexpected: 0 };
    for (const g of data?.gaps ?? []) c[g.problem]++;
    return c;
  }, [data]);
  const term = q.trim().toLowerCase();
  const shown = (data?.gaps ?? []).filter((g) => (problem === 'all' || g.problem === problem)
    && (!term || `${g.path} ${g.item} ${g.expected} ${g.actual.join(' ')}`.toLowerCase().includes(term)));

  const download = () => {
    if (!data) return;
    const rows = [['what', 'item', 'kind', 'problem', 'expected', 'found'], ...data.gaps.map((g) => [g.path, g.item, byItem.get(g.item)?.kind ?? '', PROBLEM_TEXT[g.problem], expectedText(g, byItem.get(g.item)), g.actual.join(' | ')])];
    const blob = new Blob([`﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${data.zone.name}-${data.template.name}-differences.csv`.replace(/[^\w.-]+/g, '_');
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (error && !data) return <Alert tone="bad" title="The differences could not be read">{error}</Alert>;
  if (!data) return <Loading label="Comparing the zone with the template"><SkeletonTable rows={8} cols={4} /></Loading>;
  const matched = data.checked - data.gaps.length;
  return (
    <div className="space-y-6">
      <Link href={`/console/compare/templates/${id}`} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-4" /> {data.template.name}</Link>
      <PageHeader eyebrow="Template differences" title={data.zone.name}
        description={<>Every difference between this zone and the template “{data.template.name}”, computed now from the zone’s stored configuration (its newest backup and monitoring results). Zone ID <span className="font-mono">{data.zone.id}</span>. Nothing is read from or written to Cloudflare.</>}
        actions={<>
          <span className="text-[12px] text-faint">As of {fmtDate(data.generatedAt)}</span>
          <Button variant="ghost" loading={loading} onClick={load} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          <Button onClick={download} disabled={!data.gaps.length} icon={<Download className="size-4" />}>CSV</Button>
        </>} />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Checked" value={data.checked.toLocaleString('en-US')} sub="items in the template" />
        <Stat label="Match" value={matched.toLocaleString('en-US')} tone={matched === data.checked ? 'ok' : undefined} sub={data.checked ? `${Math.round((matched / data.checked) * 100)}%` : ' '} />
        <Stat label="Missing" value={counts.missing.toLocaleString('en-US')} tone={counts.missing ? 'bad' : undefined} sub="not found in the zone" />
        <Stat label="Different" value={counts.different.toLocaleString('en-US')} tone={counts.different ? 'warn' : undefined} sub="found with another value" />
        <Stat label="Should not exist" value={counts.unexpected.toLocaleString('en-US')} tone={counts.unexpected ? 'bad' : undefined} sub="found, expected absent" />
      </div>
      <Card>
        <SectionHeader title={`${data.gaps.length.toLocaleString('en-US')} differences`} description="Expected is what the template asks for; Found is what the zone has (for a rule check, the rule that came closest and what it lacks)." />
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Problem">
            {(['all', 'missing', 'different', 'unexpected'] as Problem[]).map((p) => (
              <button key={p} type="button" aria-pressed={problem === p} onClick={() => setProblem(p)}
                className={cx('rounded-lg border px-2.5 py-1 text-[12.5px]', problem === p ? 'border-signal bg-signal/10 text-ink' : 'border-line text-muted hover:text-ink')}>
                {p === 'all' ? `All (${data.gaps.length.toLocaleString('en-US')})` : `${PROBLEM_TEXT[p]} (${counts[p].toLocaleString('en-US')})`}
              </button>
            ))}
          </div>
          <div className="min-w-[12rem] flex-1"><Field label="Find" optional><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="POL-1010, min_tls_version, OWASP" /></Field></div>
        </div>
        {!data.gaps.length ? <p className="px-5 py-8 text-center text-sm text-muted">This zone matches every item of the template.</p> : !shown.length ? <p className="px-5 py-8 text-center text-sm text-muted">No difference matches the filter.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[12.5px]">
              <thead><tr className="border-b border-line text-muted">{['What', 'Problem', 'Expected', 'Found'].map((h) => <th key={h} scope="col" className="px-4 py-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase">{h}</th>)}</tr></thead>
              <tbody>
                {shown.map((g) => {
                  const t = byItem.get(g.item);
                  return (
                    <tr key={g.item} className="border-b border-line/60 align-top last:border-0">
                      <td className="max-w-[300px] px-4 py-2">
                        {t && <Badge className="mr-1.5">{KIND_LABEL[t.kind] ?? t.kind}</Badge>}
                        <span className="break-words text-ink-2">{g.path}</span>
                        <div className="mt-0.5 font-mono text-[11px] break-all text-faint">{g.item}</div>
                      </td>
                      <td className="px-4 py-2"><Badge tone={g.problem === 'different' ? 'warn' : 'bad'}>{PROBLEM_TEXT[g.problem]}</Badge></td>
                      <td className="max-w-[360px] px-4 py-2"><Values v={[expectedText(g, t)]} /></td>
                      <td className="max-w-[360px] px-4 py-2"><Values v={g.actual} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
