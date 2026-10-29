import 'server-only';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db, must } from './supabase';
import { cachedSettings } from './settings';
import { audit } from './audit';
import { checkPassword, onSessionEnd, type Me } from './auth';
import { newId } from './store';
import {
  KINDS, MAX_EXTRA_BUCKETS, STORAGE_LABEL, approvedBuckets, groupedFields, storageFields,
  type CredentialKind, type CredentialOption, type CredentialSummary, type StorageKind, type TestResult,
} from './kinds';

// ── Vault format ────────────────────────────────────────────────────────────
// One random 256-bit data key (DEK) encrypts every credential with AES-256-GCM.
// The DEK is stored in Supabase wrapped twice:
//   dek_pw     — under scrypt(vault password). Only a super admin who enters
//                the vault password can open the vault UI / API with it.
//   dek_server — under VAULT_SERVER_KEY from the server environment. Used only
//                inside this process to inject secrets into a backup run, so
//                presets work for every role without exposing the vault.
// Neither the DEK nor any plaintext ever leaves the server.
//
// Password reset (supabase/maintenance/reset_vault_password.sql): dek_pw and kdf are
// cleared in the database. The vault then asks a super admin for a new password and
// wraps the same DEK (opened with the server key) under it: credentials are unchanged.

interface Sealed { iv: string; tag: string; ct: string }
interface Kdf { name: 'scrypt'; N: number; r: number; p: number; salt: string }
/** kdf and dek_pw are null after a password reset, until a new password is set. */
interface VaultRow { kdf: Kdf | null; dek_pw: Sealed | null; dek_server: Sealed }

export interface Credential {
  id: string;
  name: string;
  kind: CredentialKind;
  notes: string;
  fields: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastTest?: TestResult;
}

interface CredRow {
  id: string; kind: CredentialKind; name: string; sealed: Sealed; last_test: TestResult | null;
  last_used_at: string | null; created_at: string; updated_at: string;
}

const KDF = { N: 2 ** 17, r: 8, p: 1 };
const AAD_PW = 'vault-dek:password:v1';
const AAD_SERVER = 'vault-dek:server:v1';

export class VaultError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

interface Unlocked { dek: Buffer; lastActive: number }
interface State { unlocked: Map<string, Unlocked>; failures: Map<string, { count: number; blockedUntil: number }> }
const g = globalThis as unknown as { __cfVault2?: State; __cfVaultHook?: boolean };
const state: State = (g.__cfVault2 ??= { unlocked: new Map(), failures: new Map() });
if (!g.__cfVaultHook) {
  g.__cfVaultHook = true;
  onSessionEnd((hash) => wipe(hash));
}

function wipe(hash: string) {
  const u = state.unlocked.get(hash);
  u?.dek.fill(0);
  state.unlocked.delete(hash);
}

// ── Crypto ──────────────────────────────────────────────────────────────────

function deriveKey(password: string, salt: Buffer, kdf = KDF): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, 32, { ...kdf, maxmem: 512 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function seal(key: Buffer, plaintext: Buffer | string, aad: string): Sealed {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function open(key: Buffer, s: Sealed, aad: string): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(s.ct, 'base64')), decipher.final()]);
}

const tryOpen = (key: Buffer, s: Sealed, aad: string) => { try { return open(key, s, aad); } catch { return null; } };

/** VAULT_SERVER_KEY: 32 bytes as base64 (44 chars) or hex (64 chars). */
/**
 * The server key, preferably from VAULT_SERVER_KEY_FILE (a file outside the project,
 * readable only by the account running the console) so it never sits in the same
 * file as the Supabase service-role key. VAULT_SERVER_KEY inline is still accepted.
 */
function serverKey(): Buffer {
  const file = process.env.VAULT_SERVER_KEY_FILE?.trim();
  let raw = (process.env.VAULT_SERVER_KEY ?? '').trim();
  if (file) {
    try { raw = fs.readFileSync(file, 'utf8').trim(); } catch (err) {
      throw new VaultError(`Cannot read VAULT_SERVER_KEY_FILE (${(err as NodeJS.ErrnoException).code ?? 'error'})`, 500);
    }
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new VaultError('The vault server key must be 32 random bytes (base64 or hex) — see .env.example', 500);
  return key;
}

/** A key for the shared cache, derived from the server key (so cached data is unreadable without it). */
export function cacheKeyMaterial(): Buffer {
  const sk = serverKey();
  try { return Buffer.from(crypto.hkdfSync('sha256', sk, Buffer.alloc(0), 'backup-console cache v1', 32)); } finally { sk.fill(0); }
}

async function readVault(): Promise<VaultRow | null> {
  return must(await db().from('vault').select('kdf, dek_pw, dek_server').eq('id', 1).maybeSingle(), 'Reading vault') as VaultRow | null;
}

/** The vault password was reset in the database: a new one must be set before the vault opens. */
const needsNewPassword = (row: VaultRow) => !row.dek_pw || !row.kdf;

// ── Vault access (super admin + vault password) ─────────────────────────────

const requireSuperAdmin = (me: Me) => { if (me.role !== 'super_admin') throw new VaultError('Only a super admin can access the vault', 403); };
const idleMs = () => cachedSettings().vaultAutoLockMinutes * 60_000;

function current(me: Me): Unlocked | null {
  const u = state.unlocked.get(me.sessionHash);
  if (!u) return null;
  if (Date.now() - u.lastActive > idleMs()) { wipe(me.sessionHash); return null; }
  return u;
}

export async function vaultStatus(me: Me) {
  requireSuperAdmin(me);
  const u = current(me);
  const row = await readVault();
  return { initialized: !!row, passwordReset: !!row && needsNewPassword(row), unlocked: !!u, expiresAt: u ? u.lastActive + idleMs() : null };
}

/** The DEK for vault operations; requires a super admin who unlocked the vault in this session. */
export function requireVault(me: Me): Buffer {
  requireSuperAdmin(me);
  const u = current(me);
  if (!u) throw new VaultError('The vault is locked — enter the vault password', 423);
  u.lastActive = Date.now();
  return u.dek;
}

function throttle(me: Me) {
  const f = state.failures.get(me.id);
  const wait = f ? f.blockedUntil - Date.now() : 0;
  if (wait > 0) throw new VaultError(`Too many attempts — try again in ${Math.ceil(wait / 1000)}s`, 429);
}
function fail(me: Me) {
  const f = state.failures.get(me.id) ?? { count: 0, blockedUntil: 0 };
  f.count++;
  if (f.count >= 3) f.blockedUntil = Date.now() + Math.min(300_000, 1000 * 2 ** (f.count - 2));
  state.failures.set(me.id, f);
}

/**
 * Creates the vault, or — after a password reset — sets its new password. A reset keeps the
 * data key (opened with the server key), so every stored credential stays as it is.
 */
export async function initVault(me: Me, password: string) {
  requireSuperAdmin(me);
  const existing = await readVault();
  if (existing && !needsNewPassword(existing)) throw new VaultError('The vault already exists', 409);
  checkPassword(password, 'Vault password');
  const sk = serverKey();
  const salt = crypto.randomBytes(16);
  const kdf = { name: 'scrypt', ...KDF, salt: salt.toString('base64') };
  if (existing) {
    const dek = tryOpen(sk, existing.dek_server, AAD_SERVER);
    sk.fill(0);
    if (!dek) throw new VaultError('The vault server key does not match this vault, so its data key cannot be recovered for a new password. Use the server key the vault was created with', 409);
    const kek = await deriveKey(password, salt);
    must(await db().from('vault').update({ kdf, dek_pw: seal(kek, dek, AAD_PW), updated_at: new Date().toISOString() }).eq('id', 1), 'Setting the new vault password');
    kek.fill(0);
    state.failures.clear();
    for (const hash of [...state.unlocked.keys()]) wipe(hash);
    state.unlocked.set(me.sessionHash, { dek, lastActive: Date.now() });
    await audit(me, 'vault.password_reset');
    return;
  }
  const dek = crypto.randomBytes(32);
  const kek = await deriveKey(password, salt);
  const { error } = await db().from('vault').insert({
    id: 1, kdf, dek_pw: seal(kek, dek, AAD_PW), dek_server: seal(sk, dek, AAD_SERVER), created_by: me.id,
  });
  kek.fill(0);
  if (error?.code === '23505') throw new VaultError('The vault already exists', 409);
  if (error) throw new Error(`Could not create the vault: ${error.message}`); // logged; the client gets a generic 500
  state.unlocked.set(me.sessionHash, { dek, lastActive: Date.now() });
  await audit(me, 'vault.created');
}

async function unwrapWithPassword(row: VaultRow, password: string): Promise<Buffer | null> {
  if (needsNewPassword(row)) return null;
  const { N, r, p, salt } = row.kdf!;
  const kek = await deriveKey(password, Buffer.from(salt, 'base64'), { N, r, p });
  const dek = tryOpen(kek, row.dek_pw!, AAD_PW);
  kek.fill(0);
  return dek;
}

export async function unlockVault(me: Me, password: string) {
  requireSuperAdmin(me);
  const row = await readVault();
  if (!row) throw new VaultError('The vault has not been created yet', 404);
  if (needsNewPassword(row)) throw new VaultError('The vault password was reset — set a new vault password first', 409);
  throttle(me);
  const dek = typeof password === 'string' && password ? await unwrapWithPassword(row, password) : null;
  if (!dek) {
    fail(me);
    await audit(me, 'vault.unlock_failed');
    throw new VaultError('Incorrect vault password', 401);
  }
  state.failures.delete(me.id);
  // If VAULT_SERVER_KEY was rotated or lost, re-wrap the DEK for this server so runs keep working.
  const sk = serverKey();
  const viaServer = tryOpen(sk, row.dek_server, AAD_SERVER);
  if (!viaServer || !viaServer.equals(dek)) {
    must(await db().from('vault').update({ dek_server: seal(sk, dek, AAD_SERVER), updated_at: new Date().toISOString() }).eq('id', 1), 'Re-sealing vault');
    await audit(me, 'vault.server_key_resealed');
  }
  viaServer?.fill(0);
  wipe(me.sessionHash);
  state.unlocked.set(me.sessionHash, { dek, lastActive: Date.now() });
  await audit(me, 'vault.unlocked');
}

export async function lockVault(me: Me) {
  wipe(me.sessionHash);
  await audit(me, 'vault.locked');
}

export async function changeVaultPassword(me: Me, currentPw: string, next: string) {
  requireVault(me);
  const row = await readVault();
  if (!row) throw new VaultError('The vault has not been created yet', 404);
  throttle(me);
  const dek = await unwrapWithPassword(row, currentPw);
  if (!dek) { fail(me); throw new VaultError('Current vault password is incorrect', 401); }
  checkPassword(next, 'New vault password');
  const salt = crypto.randomBytes(16);
  const kek = await deriveKey(next, salt);
  // Only the password wrapping changes; credentials stay encrypted under the same DEK.
  must(await db().from('vault').update({
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') }, dek_pw: seal(kek, dek, AAD_PW), updated_at: new Date().toISOString(),
  }).eq('id', 1), 'Changing vault password');
  kek.fill(0);
  dek.fill(0);
  await audit(me, 'vault.password_changed');
}

// ── Credentials ─────────────────────────────────────────────────────────────

const CRED_COLS = 'id, kind, name, sealed, last_test, last_used_at, created_at, updated_at';
const aadFor = (id: string) => `credential:${id}`;

function decode(dek: Buffer, r: CredRow): Credential {
  let inner: { fields: Record<string, string>; notes: string };
  try {
    inner = JSON.parse(open(dek, r.sealed, aadFor(r.id)).toString('utf8'));
  } catch {
    throw new VaultError(`Credential "${r.name}" could not be decrypted`, 500);
  }
  return {
    id: r.id, name: r.name, kind: r.kind, notes: inner.notes ?? '', fields: inner.fields ?? {},
    createdAt: r.created_at, updatedAt: r.updated_at, lastUsedAt: r.last_used_at ?? undefined, lastTest: r.last_test ?? undefined,
  };
}

const hintOf = (v: string) => (v.length >= 10 ? `…${v.slice(-4)}` : '…');

export function summarize(c: Credential): CredentialSummary {
  const fields: CredentialSummary['fields'] = {};
  for (const def of KINDS[c.kind].fields) {
    const v = c.fields[def.key] ?? '';
    fields[def.key] = def.secret ? { set: !!v, hint: v ? hintOf(v) : undefined } : { set: !!v, value: v };
  }
  const { id, name, kind, notes, createdAt, updatedAt, lastUsedAt, lastTest } = c;
  return { id, name, kind, notes, fields, createdAt, updatedAt, lastUsedAt, lastTest };
}

async function row(id: string): Promise<CredRow> {
  const r = must(await db().from('credentials').select(CRED_COLS).eq('id', id).maybeSingle(), 'Reading credential') as CredRow | null;
  if (!r) throw new VaultError('Credential not found', 404);
  return r;
}

/**
 * What someone starting a backup needs to pick a credential: names, kinds and, for R2 /
 * AWS, the approved bucket names (read with the server key). No secret material.
 */
export async function listCredentialOptions(): Promise<CredentialOption[]> {
  const rows = must(await db().from('credentials').select(CRED_COLS).order('name'), 'Listing credentials') as CredRow[];
  let dek: Buffer | null = null;
  if (rows.length) {
    try {
      const v = await readVault();
      dek = v ? tryOpen(serverKey(), v.dek_server, AAD_SERVER) : null;
    } catch { dek = null; } // no server key: options still list, without bucket names
  }
  try {
    return rows.map((r) => {
      const o: CredentialOption = { id: r.id, kind: r.kind, name: r.name, tested: r.last_test ? r.last_test.ok : null };
      if (dek) {
        try {
          const f = decode(dek, r).fields;
          if (r.kind === 'cloudflare') {
            const storage: CredentialOption['storage'] = {};
            for (const g of ['r2', 'aws'] as const) { const sf = storageFields(f, g); if (sf) storage[g] = approvedBuckets(sf); }
            if (storage.r2 || storage.aws) o.storage = storage;
          } else o.buckets = approvedBuckets(f);
        } catch { /* undecryptable row: leave out */ }
      }
      return o;
    });
  } finally {
    dek?.fill(0);
  }
}

export async function listCredentials(me: Me): Promise<CredentialSummary[]> {
  const dek = requireVault(me);
  const rows = must(await db().from('credentials').select(CRED_COLS).order('created_at'), 'Listing credentials') as CredRow[];
  return rows.map((r) => summarize(decode(dek, r)));
}

export async function getCredential(me: Me, id: string): Promise<Credential> {
  return decode(requireVault(me), await row(id));
}

export interface CredentialInput {
  name?: string;
  kind?: CredentialKind;
  notes?: string;
  fields?: Record<string, string>;
}

function cleanFields(kind: CredentialKind, incoming: Record<string, string>, existing?: Record<string, string>) {
  const out: Record<string, string> = {};
  const defs = KINDS[kind].fields;
  // An optional section (R2 / AWS of an account set) is all of its required fields or none:
  // "<group>Clear" = "1" removes it; otherwise it is in use when any of its fields has a value.
  const cleared = (g?: StorageKind) => !!g && incoming[`${g}Clear`] === '1';
  const inUse = (g: StorageKind) => !cleared(g) && defs.some((d) => {
    if (d.group !== g) return false;
    const raw = incoming[d.key];
    if (typeof raw === 'string' && raw.trim()) return true;
    // A blank secret, or a field not sent at all, keeps the stored value.
    return (raw === undefined || d.secret) && !!existing?.[d.key];
  });
  for (const def of defs) {
    if (def.group && !inUse(def.group)) continue;
    const raw = incoming[def.key];
    // A blank secret on edit means "keep what is stored".
    let v = typeof raw === 'string' ? raw.trim() : '';
    if (!v && def.secret && existing) v = existing[def.key] ?? '';
    if (!v && existing && raw === undefined) v = existing[def.key] ?? '';
    if (def.key === 'accountId') v = v.toLowerCase();
    if (def.required && !v) throw new VaultError(def.group ? `${STORAGE_LABEL[def.group]}: ${def.label} is required (or leave the whole ${STORAGE_LABEL[def.group]} section empty)` : `${def.label} is required`);
    if (v && def.list) {
      // One value per line, each checked on its own; blank lines and repeats dropped.
      const items = [...new Set(v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];
      const bad = def.pattern ? items.filter((x) => !new RegExp(def.pattern!).test(x)) : [];
      if (bad.length) throw new VaultError(`${def.label}: ${def.patternHint} (not valid: ${bad.slice(0, 3).join(', ')})`);
      if (items.length > MAX_EXTRA_BUCKETS) throw new VaultError(`${def.label}: at most ${MAX_EXTRA_BUCKETS}`);
      v = items.join('\n');
    } else if (v && def.pattern && !new RegExp(def.pattern).test(v)) throw new VaultError(`${def.label}: ${def.patternHint}`);
    if (!def.multiline && /[\r\n]/.test(v)) throw new VaultError(`${def.label} must be a single line`);
    if (v && def.json) {
      let parsed: unknown;
      try { parsed = JSON.parse(v); } catch { throw new VaultError(`${def.label} must be valid JSON`); }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { rules?: unknown }).rules)) {
        throw new VaultError(`${def.label} must be JSON with a top-level "rules" array`);
      }
      if (v.length > 20_000) throw new VaultError(`${def.label} is too long`);
    }
    if (v) out[def.key] = v;
  }
  return out;
}

export async function createCredential(me: Me, input: CredentialInput): Promise<CredentialSummary> {
  const dek = requireVault(me);
  const kind = input.kind;
  if (!kind || !(kind in KINDS)) throw new VaultError('Unknown credential type');
  if (KINDS[kind].legacy) throw new VaultError('R2 and AWS storage are added to an account set now, not saved on their own');
  const name = (input.name ?? '').trim().slice(0, 80);
  if (!name) throw new VaultError('Name is required');
  const id = newId();
  const fields = cleanFields(kind, input.fields ?? {});
  const notes = (input.notes ?? '').slice(0, 500);
  const r = must(await db().from('credentials').insert({
    id, kind, name, sealed: seal(dek, JSON.stringify({ fields, notes }), aadFor(id)), created_by: me.id,
  }).select(CRED_COLS).single(), 'Saving credential') as CredRow;
  await audit(me, 'credential.created', name, { kind });
  return summarize(decode(dek, r));
}

export async function updateCredential(me: Me, id: string, input: CredentialInput): Promise<CredentialSummary> {
  const c = await getCredential(me, id);
  const dek = requireVault(me);
  let name = c.name;
  if (input.name !== undefined) {
    name = input.name.trim().slice(0, 80);
    if (!name) throw new VaultError('Name is required');
  }
  const notes = input.notes !== undefined ? input.notes.slice(0, 500) : c.notes;
  const fields = input.fields ? cleanFields(c.kind, input.fields, c.fields) : c.fields;
  const changed = JSON.stringify(fields) !== JSON.stringify(c.fields);
  const r = must(await db().from('credentials').update({
    name, sealed: seal(dek, JSON.stringify({ fields, notes }), aadFor(id)), updated_at: new Date().toISOString(),
    ...(changed ? { last_test: null } : {}),
  }).eq('id', id).select(CRED_COLS).single(), 'Updating credential') as CredRow;
  await audit(me, 'credential.updated', name, { secretsChanged: changed });
  return summarize(decode(dek, r));
}

export async function deleteCredential(me: Me, id: string) {
  requireVault(me);
  const r = await row(id);
  must(await db().from('credentials').delete().eq('id', id), 'Deleting credential');
  await audit(me, 'credential.deleted', r.name, { kind: r.kind });
}

export async function revealField(me: Me, id: string, field: string): Promise<string> {
  const c = await getCredential(me, id);
  const def = KINDS[c.kind].fields.find((f) => f.key === field);
  if (!def) throw new VaultError('Unknown field');
  if (def.secret) await audit(me, 'credential.revealed', c.name, { field });
  return c.fields[field] ?? '';
}

export async function recordTest(id: string, result: TestResult) {
  await db().from('credentials').update({ last_test: result }).eq('id', id);
}

export async function markUsed(ids: string[]) {
  if (ids.length) await db().from('credentials').update({ last_used_at: new Date().toISOString() }).in('id', ids);
}

/**
 * Moves a legacy R2 / AWS credential into an account set (server side: its secrets are never
 * shown or retyped). Refuses when the set already has that storage. Optionally deletes the source.
 */
export async function attachStorage(me: Me, setId: string, fromId: string, removeSource: boolean): Promise<CredentialSummary> {
  const set = await getCredential(me, setId);
  const from = await getCredential(me, fromId);
  if (set.kind !== 'cloudflare') throw new VaultError('Storage can only be added to an account set');
  if (from.kind !== 'r2' && from.kind !== 'aws') throw new VaultError('Only a legacy R2 or AWS credential can be moved into an account set');
  if (storageFields(set.fields, from.kind)) throw new VaultError(`"${set.name}" already has ${STORAGE_LABEL[from.kind]} — clear it first`, 409);
  const summary = await updateCredential(me, setId, { fields: { ...set.fields, ...groupedFields(from.fields, from.kind) } });
  await audit(me, 'credential.storage_attached', set.name, { storage: from.kind, from: from.name });
  if (removeSource) await deleteCredential(me, fromId);
  return summary;
}

// ── Server-side use (backup runs, zone listing) ─────────────────────────────

/** An account set's R2 / AWS storage as a credential of that kind, for uploads and restores. */
export function storageOf(c: Credential, g: StorageKind): Credential {
  if (c.kind !== 'cloudflare') throw new VaultError(`"${c.name}" is not an account set`);
  const fields = storageFields(c.fields, g);
  if (!fields) throw new VaultError(`"${c.name}" has no ${STORAGE_LABEL[g]} storage — a super admin can add it to the account set in the vault`);
  return { ...c, kind: g, fields };
}

/** Decrypts a credential with the server key. Never returned to a client — only injected into backup.js or used for API calls. */
export async function credentialForRun(id: string, kind: CredentialKind): Promise<Credential> {
  const v = await readVault();
  if (!v) throw new VaultError('The vault has not been set up yet — a super admin must create it and add credentials', 409);
  const dek = tryOpen(serverKey(), v.dek_server, AAD_SERVER);
  if (!dek) throw new VaultError('VAULT_SERVER_KEY does not match this vault — a super admin must unlock the vault once to re-seal it', 500);
  try {
    const c = decode(dek, await row(id));
    if (c.kind !== kind) throw new VaultError(`Credential "${c.name}" is not a ${KINDS[kind].short} credential`);
    return c;
  } finally {
    dek.fill(0);
  }
}
