// Why a change is asked for: a reason and a ticket (an id like "CHG-1234" or a link), captured with
// every approval request (backup, restore apply, Cloudflare action). Shared by server and client — no Node imports.

export interface ChangeNote {
  reason?: string;
  ticket?: string;
}

export const MAX_REASON = 500;
export const MAX_TICKET = 200;

/** A ticket id (letters, digits, - _ . # / :) when it is not a link. */
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9 _.#/:-]*$/;

/** The ticket as a link to open: only http(s) URLs, never javascript: or data:. */
export function ticketHref(ticket: string | null | undefined): string | null {
  const t = (ticket ?? '').trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch { return null; }
}

/**
 * Checks the reason and ticket the browser sent (fields `reason` and `ticket` of the request body).
 * Throws an Error with a user-facing message; `requireReason` makes the reason mandatory.
 */
export function checkChangeNote(raw: unknown, requireReason = false): ChangeNote {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (o.reason !== undefined && o.reason !== null && typeof o.reason !== 'string') throw new Error('The reason must be text');
  if (o.ticket !== undefined && o.ticket !== null && typeof o.ticket !== 'string') throw new Error('The ticket must be text');
  const reason = (o.reason as string | undefined ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim();
  const ticket = (o.ticket as string | undefined ?? '').trim();
  if (reason.length > MAX_REASON) throw new Error(`The reason is longer than ${MAX_REASON} characters`);
  if (ticket.length > MAX_TICKET) throw new Error(`The ticket is longer than ${MAX_TICKET} characters`);
  if (requireReason && !reason) throw new Error('Say why this change is needed: a reason is required for approval requests');
  if (ticket) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ticket) || /^(javascript|data|vbscript|file):/i.test(ticket)) {
      if (!ticketHref(ticket)) throw new Error('A ticket link must start with http:// or https://');
    } else if (!TICKET_ID.test(ticket)) {
      throw new Error('The ticket must be a ticket id (like CHG-1234) or an http(s) link');
    }
  }
  return { ...(reason ? { reason } : {}), ...(ticket ? { ticket } : {}) };
}

/** For audit details: the note's fields under names that do not clash with a rejection's `reason`. */
export const noteDetails = (n: ChangeNote | undefined | null) => (n?.reason || n?.ticket ? { changeReason: n.reason ?? null, ticket: n.ticket ?? null } : {});
