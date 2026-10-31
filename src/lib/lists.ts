import 'server-only';
import { HttpError } from './http';
import { cfGet, cfReason, ok, refused } from './cf-read';
import { filteredRows, rowAccounts } from './stored-rows';
import { tokenForAccount } from './account-token';
import type { ListItem, ListItemsPage, ListRow, RefRow } from './lists-types';

// The Lists page: the account lists and the rules that use them, as the `lists` monitoring check
// stored them (src/lib/checks/lists.ts) — one indexed query a page (src/lib/stored-rows.ts) — and a list's items, read from
// Cloudflare when someone opens it (one call a page of 50, within the token's budget).

export async function listLists(o: { account?: string; kind?: string; q?: string; offset: number; limit: number }): Promise<{ rows: ListRow[]; total: number }> {
  return filteredRows<ListRow>('lists', 'lists', o);
}

/** Accounts that have lists (for the filter). */
export const listAccounts = () => rowAccounts('lists', 'lists');

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
