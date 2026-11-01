'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Pencil, Play, RefreshCw, Send, Trash2 } from 'lucide-react';
import { api, fmtDate, relTime } from '@/lib/client';
import { SECTION_LABEL, fmtEastern, scheduleLabel, type ReportDefinition, type ReportRunSummary } from '@/lib/report-types';
import { Alert, Button, ButtonLink, Card, EmptyState, Loading, Modal, PageHeader, SectionHeader, SkeletonTable } from '@/components/ui';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { useSnapshot } from '../../monitoring/use-run';
import { ReportEditor } from '../editor';
import { RunState } from '../run-state';
import { compactNum } from '@/lib/num';

interface DetailView { definition: ReportDefinition; runs: ReportRunSummary[]; total: number; offset: number; generatedAt: string }

const period = (r: ReportRunSummary) => `${fmtEastern(r.periodStart)} – ${fmtEastern(r.periodEnd)}`;

export default function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useMe();
  const toast = useToast();
  const router = useRouter();
  const manage = can('monitors:manage');
  const { data, error, loading, reload } = useSnapshot<DetailView>(`/api/reports/${encodeURIComponent(id)}`);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState<'' | 'make' | 'send' | 'delete'>('');
  const d = data?.definition;

  const generate = async (deliver: boolean) => {
    setBusy(deliver ? 'send' : 'make');
    try {
      await api(`/api/reports/${id}/run`, { method: 'POST', json: { deliver } });
      toast(deliver ? 'Making the report now; it is sent once it is ready — press Refresh to see it' : 'Making the report now (not sent) — press Refresh to see it', 'info');
      await reload();
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(''); }
  };
  const remove = async () => {
    setBusy('delete');
    try {
      await api(`/api/reports/${id}`, { method: 'DELETE' });
      toast('Report deleted', 'ok');
      router.push('/console/reports');
    } catch (e) { toast((e as Error).message, 'bad'); setBusy(''); }
  };

  return (
    <div className="space-y-6">
      <Link href="/console/reports" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink"><ArrowLeft className="size-3.5" />All reports</Link>
      <PageHeader eyebrow="Report" title={d?.name ?? 'Report'}
        description={d ? `${scheduleLabel(d)} · ${d.scope === 'all' ? 'Everything' : d.scope === 'accounts' ? `${compactNum(d.accounts.length)} account${d.accounts.length === 1 ? '' : 's'}` : `Zones tagged ${d.tags.join(' + ')}`} · ${d.sections.map((s) => SECTION_LABEL[s]).join(', ')}` : undefined}
        actions={<>
          <Button variant="ghost" loading={loading && !!data} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {manage && d && <>
            <Button variant="ghost" onClick={() => setEditing(true)} icon={<Pencil className="size-4" />}>Change</Button>
            <Button variant="ghost" onClick={() => setDeleting(true)} icon={<Trash2 className="size-4" />}>Delete</Button>
            <Button loading={busy === 'make'} onClick={() => generate(false)} icon={<Play className="size-4" />}>Make now</Button>
            {d.channels.length > 0 && <Button variant="primary" loading={busy === 'send'} onClick={() => generate(true)} icon={<Send className="size-4" />}>Make and send</Button>}
          </>}
        </>} />
      {error && <Alert tone="bad" title="The report could not be read">{error}</Alert>}
      {d && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
          <span>Next: {d.enabled && d.nextRunAt ? fmtEastern(d.nextRunAt) : 'off (by hand only)'}</span>
          <span>Sent to: {d.channels.length ? d.channels.map((c) => (c === 'slack' ? 'Slack' : 'webhook')).join(' and ') : 'nowhere (kept here)'}</span>
          <span>Changed {relTime(d.updatedAt)}{d.updatedBy ? ` by ${d.updatedBy}` : ''}</span>
          <span className="ml-auto text-faint">As of {data && new Date(data.generatedAt).toLocaleTimeString()}</span>
        </div>
      )}
      <Card>
        <SectionHeader title="History" description="The newest 50 reports made. A report goes to each channel once; a failed send is shown, not repeated." />
        {!data ? (!error && <Loading label="Loading history" className="p-5"><SkeletonTable rows={4} cols={3} /></Loading>)
          : !data.runs.length ? <div className="p-5"><EmptyState icon={<Play className="size-5" />} title="Not made yet" description={d?.enabled && d.nextRunAt ? `The first one is made at ${fmtEastern(d.nextRunAt)}.` : 'Make one by hand.'} /></div>
          : (
            <ul className="divide-y divide-line/70">
              {data.runs.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 text-[13px]">
                  <div className="min-w-0">
                    {r.status === 'ready' ? <Link href={`/console/reports/runs/${r.id}`} className="font-medium text-ink hover:text-signal">{period(r)}</Link> : <span className="font-medium text-ink-2">{period(r)}</span>}
                    <div className="mt-0.5 text-xs text-muted">{r.trigger === 'manual' ? `By hand${r.requestedBy ? `, ${r.requestedBy}` : ''}` : 'On schedule'} · <span title={fmtDate(r.startedAt)}>{relTime(r.startedAt)}</span>{r.headline ? ` · ${r.headline}` : ''}</div>
                    {r.error && <div className="mt-0.5 text-xs text-bad">{r.error}</div>}
                    {Object.entries(r.deliveries).filter(([, x]) => x?.error).map(([ch, x]) => <div key={ch} className="mt-0.5 text-xs text-bad">{ch === 'slack' ? 'Slack' : 'Webhook'}: {x?.error}</div>)}
                  </div>
                  <div className="flex items-center gap-2">
                    <RunState run={r} />
                    {r.status === 'ready' && <ButtonLink size="sm" variant="ghost" href={`/api/reports/runs/${r.id}/download?format=html`} download>HTML</ButtonLink>}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>
      {d && <ReportEditor open={editing} onClose={() => setEditing(false)} initial={d} onSaved={() => { setEditing(false); toast('Saved', 'ok'); void reload(); }} />}
      <Modal open={deleting} onClose={() => setDeleting(false)} title="Delete this report?" description="Its settings and every report made from it are deleted. Reports already sent stay where they were sent."
        footer={<><Button variant="ghost" onClick={() => setDeleting(false)}>Keep it</Button><Button variant="danger" loading={busy === 'delete'} onClick={remove} icon={<Trash2 className="size-4" />}>Delete</Button></>}>
        <p className="text-[13px] text-ink-2">{d?.name}</p>
      </Modal>
    </div>
  );
}
