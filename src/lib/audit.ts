import 'server-only';
import { db } from './supabase';
import type { AuditEntry } from './audit-changes';

export interface Actor { id: string | null; email: string | null }

/** Best-effort: an audit write failure is logged but never blocks the action itself. */
export async function audit(actor: Actor | null, action: string, target?: string | null, details?: Record<string, unknown>) {
  try {
    const { error } = await db().from('audit_log').insert({
      actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, action, target: target ?? null, details: details ?? null,
    });
    if (error) console.error('audit write failed:', error.message);
  } catch (err) {
    console.error('audit write failed:', err);
  }
}

export type { AuditEntry } from './audit-changes';

export async function listAudit(opts: { limit?: number; before?: number; action?: string } = {}): Promise<AuditEntry[]> {
  let q = db().from('audit_log').select('id, at, actor_email, action, target, details').order('id', { ascending: false }).limit(Math.min(opts.limit ?? 100, 500));
  if (opts.before) q = q.lt('id', opts.before);
  // A prefix match. Action names use _, a LIKE wildcard: escape it (and \ and %) so it is literal.
  if (opts.action) q = q.like('action', `${opts.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const { data, error } = await q;
  if (error) throw new Error(`Audit query failed: ${error.message}`);
  return (data ?? []).map(toEntry);
}

const toEntry = (r: Record<string, unknown>): AuditEntry => ({
  id: r.id as number, at: r.at as string, actorEmail: r.actor_email as string | null, action: r.action as string,
  target: r.target as string | null, details: r.details as Record<string, unknown> | null,
});

/** Every entry at or after `since`, newest first, up to `max` (then `truncated`). */
export async function auditSince(since: Date, max = 5000): Promise<{ entries: AuditEntry[]; truncated: boolean }> {
  const PAGE = 1000;
  const entries: AuditEntry[] = [];
  let before: number | undefined;
  while (entries.length < max) {
    let q = db().from('audit_log').select('id, at, actor_email, action, target, details')
      .gte('at', since.toISOString()).order('id', { ascending: false }).limit(Math.min(PAGE, max - entries.length));
    if (before !== undefined) q = q.lt('id', before);
    const { data, error } = await q;
    if (error) throw new Error(`Audit query failed: ${error.message}`);
    const rows = (data ?? []).map(toEntry);
    entries.push(...rows);
    if (rows.length < PAGE) return { entries, truncated: false };
    before = rows[rows.length - 1].id;
  }
  // Exactly `max` read: truncated only if something older is still inside the window.
  const { count } = await db().from('audit_log').select('id', { count: 'exact', head: true }).gte('at', since.toISOString()).lt('id', entries[entries.length - 1].id);
  return { entries, truncated: (count ?? 0) > 0 };
}
