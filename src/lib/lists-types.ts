// The Lists page's shapes. Shared by server and client — no Node imports.

export const LIST_KINDS = ['ip', 'asn', 'hostname', 'redirect'] as const;
export type ListKind = (typeof LIST_KINDS)[number];
export const LIST_KIND_LABEL: Record<ListKind, string> = { ip: 'IP', asn: 'ASN', hostname: 'Hostname', redirect: 'Redirect' };

/** One list, as the `lists` check stored it. */
export interface ListRow {
  listId: string; accountId: string; account: string; name: string; kind: string; items: number; refs: number;
  referencedBy: string; description: string; modified: string | null;
}
/** One rule that uses a list. */
export interface RefRow { accountId: string; zoneId: string; list: string; where: string; ruleset: string; phase: string; rule: string; action: string; enabled: boolean }

export interface ListItem { id: string; value: string; comment: string; modified: string | null }
export interface ListItemsPage { items: ListItem[]; cursor: string | null; generatedAt: string }

export interface ListsView { rows: ListRow[]; total: number; offset: number; accounts?: { id: string; name: string }[]; lastRun?: string | null; generatedAt: string }
export interface RefsView { rows: RefRow[]; total: number; offset: number }
