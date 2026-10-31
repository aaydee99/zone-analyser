// The onboarding page's shapes. Shared by server and client — no Node imports.

import type { DiffKind, DiffRow } from './bind-zone';

export interface CompareView {
  zoneId: string; zone: string; accountName: string;
  rows: DiffRow[]; counts: Record<DiffKind, number>; compared: { file: number; current: number };
  /** Lines of the file that could not be read (the first 100), and how many in all. */
  errors: { line: number; text: string }[]; errorCount: number;
  originInFile: string;
  /** When Cloudflare's records were read (they are kept five minutes). */
  readAt: string; cached: boolean;
}

export interface WatchView {
  zoneId: string; zone: string; accountName: string; status: string; type: string; paused: boolean;
  /** Nameservers Cloudflare assigned, the ones the domain had before, and what public DNS returns now. */
  assigned: string[]; original: string[]; registrar: string | null; seen: string[];
  delegation: 'ok' | 'missing' | 'extra' | 'elsewhere' | 'unknown'; missing: string[]; extra: string[];
  dnsStatus: string; createdOn: string | null; activatedOn: string | null; checkedAt: string;
}

export interface PendingRow { zoneId: string; zone: string; account: string; status: string; delegation: string; assigned: string; seen: string; createdOn: string | null }
export interface PendingView { rows: PendingRow[]; total: number; offset: number; generatedAt: string }
