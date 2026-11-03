'use client';

import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { clientReport } from '@/lib/zone-audit/client-report';
import type { AuditReport } from '@/lib/zone-audit/types';
import { Button, ButtonLink, Field, Modal } from '@/components/ui';

/**
 * The client version of the audit as a Word document ("Gaps and recommendations"). Asks who it is for,
 * then shows what to check before sending and where the document departs from the audit (the same
 * rules the server uses: src/lib/zone-audit/client-report.ts).
 */
export function ClientReportButton({ r, href }: { r: AuditReport; href: (client: string) => string }) {
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState(r.zone.accountName || '');
  const name = client.replace(/\s+/g, ' ').trim().slice(0, 120);
  const plan = useMemo(() => (open ? clientReport(r, { client: name || 'Client' }) : null), [open, r, name]);
  return (
    <>
      <Button icon={<FileText className="size-4" />} onClick={() => setOpen(true)}>Client report</Button>
      <Modal open={open} onClose={() => setOpen(false)} width="max-w-2xl" title="Client report: Gaps and recommendations"
        description={`A Word document about ${r.zone.name} written for the client: findings grouped into gaps, with no internal details.`}
        footer={<>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <ButtonLink variant="primary" href={href(name)} download disabled={!name} icon={<FileText className="size-4" />}>Download Word document</ButtonLink>
        </>}>
        <Field label="Prepared for" hint="The client's name as it appears on the cover." error={!name ? 'Name the client the report is for.' : undefined}>
          <input id="client-report-name" className="input" maxLength={120} value={client} onChange={(e) => setClient(e.target.value)} />
        </Field>
        {plan && (
          <div className="mt-5 space-y-4 text-[13px]">
            <p className="text-muted">
              {plan.executive.total} findings in {plan.gaps.length} gaps: {plan.executive.counts.filter((c) => c.findings).map((c) => `${c.findings} ${c.severity}`).join(', ')}.
              File: <span className="font-mono text-ink-2 break-all">{plan.fileName}</span>
            </p>
            <section>
              <h3 className="text-sm font-medium text-ink">Before sending</h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-ink-2">{plan.checks.map((x) => <li key={x}>{x}</li>)}</ul>
            </section>
            <section>
              <h3 className="text-sm font-medium text-ink">Where the report departs from the audit</h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-ink-2">{plan.departures.map((x) => <li key={x}>{x}</li>)}</ul>
            </section>
          </div>
        )}
      </Modal>
    </>
  );
}
