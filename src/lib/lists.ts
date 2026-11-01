import 'server-only';
import { HttpError } from './http';
import { cached } from './cache';
import { cfGet, cfList, cfReason, inParallel, ok, refused } from './cf-read';
import { filteredRows } from './stored-rows';
import { tokenForAccount } from './account-token';
import { credentialForRun, listCredentialOptions } from './vault';
import { tokenAccounts } from './providers';
import type { ListItem, ListItemsPage, ListRow, RefRow } from './lists-types';

// The Lists page, read-only. The lists themselves are read from Cloudflare (one GET per account,
// with the first stored token that reads it, within each token's budget) and kept ten minutes, so
// the page has data without waiting for monitoring. The rules that use each list come from the
// `lists` monitoring check (src/lib/checks/lists.ts) once it has read the account. A list's items are
// read when someone opens it (one call a page of 50).

interface CfListMeta { id: string; name: string; kind?: string; num_items?: number; description?: string; created_on?: string; modified_on?: string }
interface LiveLists { rows: ListRow[]; accounts: { id: string; name: string }[]; problems: { account: string; error: string }[]; readAt: string }

const LIVE_TTL_MS = 10 * 60_000;

/** Every account the stored Cloudflare tokens read, each with the first token that reads it. */
async function readableAccounts(): Promise<Map<string, { token: string; name: string }>> {
  const out = new Map<string, { token: string; name: string }>();
  for (const o of (await listCredentialOptions()).filter((x) => x.kind === 'cloudflare')) {
    try {
      const c = await credentialForRun(o.id, 'cloudflare');
      const token = c.fields.apiToken;
      if (!token) continue;
      for (const a of await tokenAccounts(c)) if (!out.has(a.id)) out.set(a.id, { token, name: a.name || o.name || a.id });
    } catch { /* this credential cannot be read: the others still are */ }
  }
  return out;
}

async function readLive(): Promise<LiveLists> {
  const accounts = await readableAccounts();
  const rows: ListRow[] = [];
  const problems: LiveLists['problems'] = [];
  await inParallel([...accounts], 6, async ([id, a]) => {
    try {
      const all = await cfList<CfListMeta>(a.token, `/accounts/${id}/rules/lists`, { perPage: 0 });
      for (const l of all) {
        rows.push({ listId: l.id, accountId: id, account: a.name, name: l.name, kind: l.kind ?? 'ip', items: l.num_items ?? 0, refs: null, referencedBy: '', description: l.description ?? '', modified: l.modified_on ?? l.created_on ?? null });
      }
    } catch (err) {
      problems.push({ account: a.name, error: err instanceof Error ? err.message : String(err) });
    }
  });
  return {
    rows, problems,
    accounts: [...new Map(rows.map((r) => [r.accountId, r.account])).entries()].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name)),
    readAt: new Date().toISOString(),
  };
}

/** The lists as monitoring stored them (rules that use each), or nothing when it has not run (or 0018 is missing). */
async function storedUse(): Promise<Map<string, { refs: number; referencedBy: string }>> {
  try {
    const { rows } = await filteredRows<ListRow>('lists', 'lists', { limit: 5000 });
    return new Map(rows.map((r) => [`${r.accountId}:${r.listId}`, { refs: Number(r.refs ?? 0), referencedBy: r.referencedBy }]));
  } catch {
    return new Map();
  }
}

/** One page of lists, newest read from Cloudflare (`fresh`: read again now instead of the copy kept ten minutes). */
export async function listLists(o: { account?: string; kind?: string; q?: string; offset: number; limit: number; fresh?: boolean }) {
  const [live, use] = await Promise.all([cached<LiveLists>('lists:live', LIVE_TTL_MS, readLive, o.fresh), storedUse()]);
  const q = (o.q ?? '').toLowerCase();
  const rows = live.rows
    .filter((r) => (!o.account || r.accountId === o.account) && (!o.kind || r.kind === o.kind)
      && (!q || `${r.name} ${r.description} ${r.account}`.toLowerCase().includes(q)))
    .map((r) => { const u = use.get(`${r.accountId}:${r.listId}`); return u ? { ...r, refs: u.refs, referencedBy: u.referencedBy } : r; })
    .sort((a, b) => b.items - a.items || a.name.localeCompare(b.name));
  return { rows: rows.slice(o.offset, o.offset + o.limit), total: rows.length, accounts: live.accounts, problems: live.problems, readAt: live.readAt };
}

export async function listRefs(o: { account: string; list: string; offset: number; limit: number }): Promise<{ rows: RefRow[]; total: number }> {
  return filteredRows<RefRow>('lists', 'refs', o);
}

interface RawItem { id: string; ip?: string; asn?: number; hostname?: { url_hostname?: string }; redirect?: { source_url?: string; target_url?: string; status_code?: number }; comment?: string; created_on?: string; modified_on?: string }

/** One page of a list's items, read now. `search`: Cloudflare's own (IPs by prefix, hostnames and redirects by substring, ASNs exactly). */
export async function listItems(accountId: string, listId: string, opts: { cursor?: string; search?: string; perPage?: number }): Promise<ListItemsPage> {
  const token = await tokenForAccount(accountId);
  const q = new URLSearchParams({ per_page: String(opts.perPage ?? 50) });
  if (opts.cursor) q.set('cursor', opts.cursor);
  if (opts.search) q.set('search', opts.search);
  const r = await cfGet<RawItem[]>(token, `/accounts/${accountId}/rules/lists/${listId}/items?${q}`);
  if (!ok(r)) throw new HttpError(refused(r) ? 403 : r.status === 404 ? 404 : 502, refused(r) ? `Cloudflare refused it: the stored token needs “Account Filter Lists Read” (${cfReason(r)})` : `Cloudflare: ${cfReason(r)}`);
  const info = (r.body!.result_info ?? {}) as { cursors?: { after?: string } };
  const items: ListItem[] = (Array.isArray(r.body!.result) ? r.body!.result : []).map((x) => ({
    id: x.id,
    value: x.ip ?? (x.asn !== undefined ? `AS${x.asn}` : x.hostname?.url_hostname ?? (x.redirect ? `${x.redirect.source_url ?? ''} → ${x.redirect.target_url ?? ''}${x.redirect.status_code ? ` (${x.redirect.status_code})` : ''}` : '')),
    comment: x.comment ?? '', modified: x.modified_on ?? x.created_on ?? null,
  }));
  return { items, cursor: info.cursors?.after ?? null, generatedAt: new Date().toISOString() };
}
