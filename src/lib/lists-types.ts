// The Lists page's shapes. Shared by server and client — no Node imports.

export const LIST_KINDS = ['ip', 'asn', 'hostname', 'redirect'] as const;
export type ListKind = (typeof LIST_KINDS)[number];
export const LIST_KIND_LABEL: Record<ListKind, string> = { ip: 'IP', asn: 'ASN', hostname: 'Hostname', redirect: 'Redirect' };

/** One list. `refs` and `referencedBy` come from the `lists` monitoring check: null until it has read the account. */
export interface ListRow {
  listId: string; accountId: string; account: string; name: string; kind: string; items: number; refs: number | null;
  referencedBy: string; description: string; modified: string | null;
}
/** One rule that uses a list. */
export interface RefRow { accountId: string; zoneId: string; list: string; where: string; ruleset: string; phase: string; rule: string; action: string; enabled: boolean }

export interface ListItem { id: string; value: string; comment: string; modified: string | null }
export interface ListItemsPage { items: ListItem[]; cursor: string | null; generatedAt: string }

/** `readAt`: when the lists were read from Cloudflare; `problems`: accounts that could not be read, and why. */
export interface ListsView { rows: ListRow[]; total: number; offset: number; accounts?: { id: string; name: string }[]; problems?: { account: string; error: string }[]; readAt?: string; generatedAt: string }
export interface RefsView { rows: RefRow[]; total: number; offset: number }
