import 'server-only';
import { audit } from './audit';
import type { Me } from './auth';
import { BudgetError, cfGet, mask } from './cf-read';
import { HttpError } from './http';
import { tokenAccounts } from './providers';
import { db } from './supabase';
import { credentialForRun, listCredentialOptions } from './vault';
import { listZones } from './zone-explorer';
import { opsMust } from './ops-store';
import { MAX_RESPONSE_BYTES, MAX_SAVED, PathError, checkPath, fillPath, nextPagePath, type ResultInfo } from './api-console-paths';

// The read-only API console: one GET under api.cloudflare.com/client/v4 with a stored token, through
// the same per-token budget as monitoring and actions (cf-read.ts). Only GET is ever sent, only to
// the paths checkPath allows. Secret-looking values in the answer are masked; the token never leaves
// this module. Every call is audited with its path only — never the answer.

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ConsoleCredential { id: string; name: string }

/** The stored Cloudflare credentials (names only). */
export async function consoleCredentials(): Promise<ConsoleCredential[]> {
  return (await listCredentialOptions()).filter((o) => o.kind === 'cloudflare').map((o) => ({ id: o.id, name: o.name }));
}

async function credential(credentialId: unknown) {
  if (typeof credentialId !== 'string' || !ID.test(credentialId)) throw new HttpError(400, 'Choose a stored credential');
  const known = (await consoleCredentials()).find((c) => c.id === credentialId);
  if (!known) throw new HttpError(404, 'No such Cloudflare credential');
  const c = await credentialForRun(credentialId, 'cloudflare');
  if (!c.fields.apiToken) throw new HttpError(409, `Credential “${known.name}” has no API token`);
  return { c, name: known.name };
}

/** The accounts a credential's token reaches (kept five minutes by providers.ts). */
export async function credentialAccounts(credentialId: unknown): Promise<{ id: string; name: string }[]> {
  const { c } = await credential(credentialId);
  const names = new Map<string, string>();
  try { for (const z of (await listZones()).zones) if (z.accountId && z.accountName) names.set(z.accountId, z.accountName); } catch { /* names stay blank */ }
  try {
    return (await tokenAccounts(c)).map((a) => ({ id: a.id, name: a.name || names.get(a.id) || a.id })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : 'Could not list the token’s accounts');
  }
}

/** One page of the zones a credential reads (from the Zone explorer's cached list), by name. */
export async function credentialZones(credentialId: unknown, opts: { q?: string; accountId?: string; offset?: number; limit?: number }) {
  await credential(credentialId);
  const list = await listZones();
  const term = (opts.q ?? '').trim().toLowerCase().slice(0, 100);
  const all = list.zones.filter((z) => (list.readersOf[z.id] ?? []).includes(credentialId as string) && (!opts.accountId || z.accountId === opts.accountId) && (!term || z.name.includes(term)));
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  return { zones: all.slice(offset, offset + limit).map((z) => ({ id: z.id, name: z.name, accountId: z.accountId, accountName: z.accountName })), total: all.length, offset };
}

export interface QueryResult {
  path: string;
  status: number;
  ok: boolean;
  ms: number;
  bytes: number;
  /** The answer (masked), unless it was cut: then `text` holds its first MAX_RESPONSE_BYTES. */
  body?: unknown;
  text?: string;
  truncated: boolean;
  info: ResultInfo | null;
  next: string | null;
}

/** Runs one GET. `path` may hold {account_id} / {zone_id}, filled from accountId / zoneId. */
export async function runQuery(me: Me, raw: { credentialId?: unknown; path?: unknown; accountId?: unknown; zoneId?: unknown }): Promise<QueryResult> {
  const accountId = typeof raw.accountId === 'string' && raw.accountId ? raw.accountId : undefined;
  const zoneId = typeof raw.zoneId === 'string' && raw.zoneId ? raw.zoneId : undefined;
  if ((accountId && !ID.test(accountId)) || (zoneId && !ID.test(zoneId))) throw new HttpError(400, 'Unknown account or zone');
  let path: string;
  try { path = checkPath(fillPath(String(raw.path ?? ''), { accountId, zoneId })); } catch (err) {
    if (err instanceof PathError) throw new HttpError(400, err.message);
    throw err;
  }
  const { c, name } = await credential(raw.credentialId);
  const started = Date.now();
  let r;
  try {
    r = await cfGet(c.fields.apiToken, path);
  } catch (err) {
    if (err instanceof BudgetError) throw new HttpError(429, 'This token’s share of Cloudflare’s rate limit is spent for now — try again in a minute');
    throw err;
  }
  const ms = Date.now() - started;
  const body = r.body ? mask(r.body) : null;
  const serial = body ? JSON.stringify(body) : r.text ?? '';
  const bytes = Buffer.byteLength(serial);
  const truncated = bytes > MAX_RESPONSE_BYTES;
  const info = (r.body?.result_info ?? null) as ResultInfo | null;
  await audit(me, 'cloudflare.query', path, { credential: name, status: r.status, bytes, ms });
  const out: QueryResult = { path, status: r.status, ok: r.status >= 200 && r.status < 300, ms, bytes, truncated, info, next: nextPagePath(path, info) };
  if (truncated) out.text = Buffer.from(serial).subarray(0, MAX_RESPONSE_BYTES).toString('utf8');
  else if (body) out.body = body;
  else out.text = r.status === 0 ? 'Could not reach the Cloudflare API' : serial;
  return out;
}

// ── Saved queries (per user) ────────────────────────────────────────────────

export interface SavedQuery { id: string; name: string; path: string; createdAt: string }

export async function listSaved(me: Me): Promise<SavedQuery[]> {
  const rows = opsMust(await db().from('api_saved_queries').select('id, name, path, created_at').eq('user_id', me.id).order('created_at', { ascending: false }).limit(MAX_SAVED), 'Reading saved queries') as { id: string; name: string; path: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, path: r.path, createdAt: r.created_at }));
}

/** Saves a path as typed (placeholders kept), after checking it would be allowed. */
export async function saveQuery(me: Me, raw: { name?: unknown; path?: unknown }): Promise<SavedQuery> {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'Give the query a name (up to 100 characters)');
  try { checkPath(fillPath(path, { accountId: '0'.repeat(32), zoneId: '0'.repeat(32) })); } catch (err) {
    if (err instanceof PathError) throw new HttpError(400, err.message);
    throw err;
  }
  const res = await db().from('api_saved_queries').select('id', { count: 'exact', head: true }).eq('user_id', me.id);
  opsMust(res, 'Counting saved queries');
  if ((res.count ?? 0) >= MAX_SAVED) throw new HttpError(409, `You have ${MAX_SAVED} saved queries — delete one first`);
  const row = opsMust(await db().from('api_saved_queries').insert({ user_id: me.id, name, path }).select('id, name, path, created_at').single(), 'Saving the query') as { id: string; name: string; path: string; created_at: string };
  await audit(me, 'api_query.saved', name, { path });
  return { id: row.id, name: row.name, path: row.path, createdAt: row.created_at };
}

export async function deleteSaved(me: Me, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'No such saved query');
  const rows = opsMust(await db().from('api_saved_queries').delete().eq('id', id).eq('user_id', me.id).select('name'), 'Deleting the query') as { name: string }[];
  if (!rows.length) throw new HttpError(404, 'No such saved query');
  await audit(me, 'api_query.deleted', rows[0].name);
}
