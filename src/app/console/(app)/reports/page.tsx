'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FileText, MessageSquare, Plus, RefreshCw } from 'lucide-react';
import { fmtDate, relTime } from '@/lib/client';
import { SECTION_LABEL, fmtEastern, scheduleLabel, type ReportDefinition, type ReportRunSummary } from '@/lib/report-types';
import { Alert, Button, ButtonLink, Card, EmptyState, Loading, PageHeader, SkeletonTable } from '@/components/ui';
import { useMe } from '@/components/me';
import { useToast } from '@/components/toast';
import { useSnapshot } from '../monitoring/use-run';
import { ReportEditor } from './editor';
import { RunState } from './run-state';

type Item = ReportDefinition & { latest: ReportRunSummary | null };
interface ListView { definitions: Item[]; total: number; offset: number; generatedAt: string }

const PAGE = 50;

export default function ReportsPage() {
  const { can } = useMe();
  const toast = useToast();
  const manage = can('monitors:manage');
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useSnapshot<ListView>(`/api/reports?offset=${offset}&limit=${PAGE}`);
  const [editing, setEditing] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Reports" title="Scheduled reports"
        description="Daily or weekly summaries of configuration changes, monitoring findings, traffic, expiring certificates and coverage — made by the worker and sent to Slack or the webhook, or kept here to download."
        actions={<>
          <Button variant="ghost" loading={loading && !!data} onClick={reload} icon={<RefreshCw className="size-4" />}>Refresh</Button>
          {can('settings:read') && <ButtonLink href="/console/settings/slack" variant="ghost" icon={<MessageSquare className="size-4" />}>Slack command</ButtonLink>}
          {manage && <Button variant="primary" onClick={() => setEditing(true)} icon={<Plus className="size-4" />}>New report</Button>}
        </>} />
      {error && <Alert tone="bad" title="Reports could not be read">{error}</Alert>}
      {!data ? (
        !error && <Loading label="Loading reports"><SkeletonTable rows={5} cols={4} /></Loading>
      ) : !data.definitions.length ? (
        <EmptyState icon={<FileText className="size-5" />} title="No reports yet" description={manage ? 'Create one: choose what it covers, when it runs and where it goes.' : 'An admin can set up scheduled reports here.'}
          action={manage ? <Button variant="primary" onClick={() => setEditing(true)} icon={<Plus className="size-4" />}>New report</Button> : undefined} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="border-b border-line text-xs text-muted">
              <tr><th scope="col" className="px-5 py-2.5 font-medium">Report</th><th scope="col" className="px-3 py-2.5 font-medium">Schedule</th><th scope="col" className="px-3 py-2.5 font-medium">Newest</th><th scope="col" className="px-5 py-2.5 font-medium">Next</th></tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {data.definitions.map((d) => (
                <tr key={d.id}>
                  <td className="px-5 py-3 align-top">
                    <Link href={`/console/reports/${d.id}`} className="font-medium text-ink hover:text-signal">{d.name}</Link>
                    <div className="mt-0.5 text-xs text-muted">{d.scope === 'all' ? 'Everything' : d.scope === 'accounts' ? `${d.accounts.length} account${d.accounts.length === 1 ? '' : 's'}` : `Tags: ${d.tags.join(' + ')}`} · {d.sections.map((s) => SECTION_LABEL[s]).join(', ')}</div>
                  </td>
                  <td className="px-3 py-3 align-top text-ink-2">{scheduleLabel(d)}<div className="text-xs text-muted">{d.channels.length ? `To ${d.channels.map((c) => (c === 'slack' ? 'Slack' : 'webhook')).join(' and ')}` : 'Kept in the console'}</div></td>
                  <td className="px-3 py-3 align-top"><RunState run={d.latest} />{d.latest && <div className="mt-0.5 text-xs text-faint" title={fmtDate(d.latest.startedAt)}>{relTime(d.latest.startedAt)}</div>}</td>
                  <td className="px-5 py-3 align-top text-ink-2">{d.enabled && d.nextRunAt ? <span title={fmtDate(d.nextRunAt)}>{fmtEastern(d.nextRunAt)}</span> : <span className="text-faint">Off (by hand only)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-muted">
            <span>{data.offset + 1}–{data.offset + data.definitions.length} of {data.total} · As of {new Date(data.generatedAt).toLocaleTimeString()}</span>
            <span className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
              <Button size="sm" variant="ghost" disabled={data.offset + data.definitions.length >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
            </span>
          </div>
        </Card>
      )}
      <p className="text-xs text-muted">Reports run on the worker at their hour, US Eastern time (EST/EDT). Numbers are only what was read: a section that could not be read says why, and an empty one says “nothing”.</p>
      <ReportEditor open={editing} onClose={() => setEditing(false)} initial={null} onSaved={(d) => { setEditing(false); toast(`“${d.name}” saved`, 'ok'); void reload(); }} />
    </div>
  );
}
