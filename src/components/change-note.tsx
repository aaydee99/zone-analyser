'use client';

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '@/lib/client';
import { MAX_REASON, MAX_TICKET, ticketHref, type ChangeNote } from '@/lib/change-note';
import { Field } from './ui';

// The reason and ticket fields of an approval request (backup, restore apply, Cloudflare action),
// and how a request shows them. Whether the reason is required comes from Settings (asked once per tab).

let policy: Promise<{ requireReason: boolean }> | null = null;

/** Whether Settings require a reason with approval requests (false until known, or when it cannot be read). */
export function useRequireReason(): boolean {
  const [req, setReq] = useState(false);
  useEffect(() => {
    let live = true;
    policy ??= api<{ requireReason: boolean }>('/api/approvals/policy').catch(() => { policy = null; return { requireReason: false }; });
    policy.then((p) => { if (live) setReq(!!p.requireReason); });
    return () => { live = false; };
  }, []);
  return req;
}

/** The note as a request body takes it: `{ reason, ticket }` with blanks left out. */
export const noteBody = (n: ChangeNote) => ({ ...(n.reason?.trim() ? { reason: n.reason.trim() } : {}), ...(n.ticket?.trim() ? { ticket: n.ticket.trim() } : {}) });

/** True when the note can be sent (a reason, if Settings require one). */
export const noteReady = (n: ChangeNote, requireReason: boolean) => !requireReason || !!n.reason?.trim();

/** `stacked`: one column (a narrow side panel). */
export function ChangeNoteFields({ value, onChange, requireReason, disabled, stacked }: { value: ChangeNote; onChange: (n: ChangeNote) => void; requireReason: boolean; disabled?: boolean; stacked?: boolean }) {
  return (
    <div className={stacked ? 'grid gap-4' : 'grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]'}>
      <Field label="Reason for the change" optional={!requireReason} hint={requireReason ? 'Required: shown to the approver and kept in the audit log.' : 'Shown to the approver and kept in the audit log.'}>
        <textarea className="input min-h-[64px]" rows={2} maxLength={MAX_REASON} disabled={disabled} required={requireReason} aria-required={requireReason}
          value={value.reason ?? ''} onChange={(e) => onChange({ ...value, reason: e.target.value })} placeholder="Why is this needed?" />
      </Field>
      <Field label="Ticket" optional hint="A ticket id (CHG-1234) or an https:// link.">
        <input className="input" maxLength={MAX_TICKET} disabled={disabled} value={value.ticket ?? ''} onChange={(e) => onChange({ ...value, ticket: e.target.value })} placeholder="CHG-1234" />
      </Field>
    </div>
  );
}

/** A ticket: a link (opened without referrer or opener) when it is an http(s) URL, plain text otherwise. */
export function TicketLink({ ticket }: { ticket: string }) {
  const href = ticketHref(ticket);
  if (!href) return <span className="font-mono text-[12px] text-ink-2">{ticket}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 break-all text-signal hover:underline">
      {ticket}<ExternalLink className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

/** "Why: … · Ticket: …" under a request. Nothing when the request has neither. */
export function NoteView({ note, className }: { note?: ChangeNote | null; className?: string }) {
  if (!note?.reason && !note?.ticket) return null;
  return (
    <dl className={className ?? 'space-y-1 text-[13px]'}>
      {note.reason && <div className="flex gap-2"><dt className="shrink-0 text-muted">Why</dt><dd className="min-w-0 break-words whitespace-pre-wrap text-ink">{note.reason}</dd></div>}
      {note.ticket && <div className="flex gap-2"><dt className="shrink-0 text-muted">Ticket</dt><dd className="min-w-0"><TicketLink ticket={note.ticket} /></dd></div>}
    </dl>
  );
}
