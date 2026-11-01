import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OUTPUT_DIR } from './store';
import { cachedSettings } from './settings';
import { HttpError } from './http';
import { credentialForRun, listCredentialOptions, storageOf, type Credential } from './vault';
import { bucketTarget, getObject, listObjects, type BucketTarget } from './bucket-store';
import { parseBackupFolder } from './restore-hcl';

// Where backups of a zone can be read from, read-only: the backup folders on this server (OUTPUT_DIR)
// and every approved R2 / S3 bucket of the stored credentials. Used by the search index and by
// comparisons; restores keep their own, stricter reader (completion manifests) in restore.ts.

export interface BackupRef {
  /** Opaque: "local:<folder>" or "bucket:<credential id>:<r2|aws>:<bucket>:<folder>". */
  ref: string;
  folder: string;
  time: string;
  partial: boolean;
  where: string;
}
export interface BackupFiles { ref: BackupRef; files: { name: string; text: string }[] }

const FOLDER = /^[A-Za-z0-9_-]{1,200}$/;
/** The folder backup.js writes a zone into (its name with anything unusual as "_"). */
export const zoneFolder = (zoneName: string) => zoneName.replace(/[^a-zA-Z0-9._-]/g, '_');
/** The account part of a backup folder name ("<account>_<YYYYMMDD>_<HHMMSS>"). */
export const accountFolder = (accountName: string) => accountName.replace(/[^a-zA-Z0-9_-]/g, '_');
/** Largest .tf file read (a zone with a huge file is read without it). */
const MAX_FILE = 8 * 1024 * 1024;
const SKIP = new Set(['provider.tf', 'imports.tf']);

// ── This server's backup folders ────────────────────────────────────────────
// OUTPUT_DIR is chosen at run time, so the turbopackIgnore comments keep the build from tracing
// the whole project into the server bundle for these reads.

function outRoot(): string | null {
  const out = path.resolve(cachedSettings().outputDir || DEFAULT_OUTPUT_DIR);
  try { return fs.realpathSync(out); } catch { return null; }
}

/** Backup folders on this server, newest first. */
export function localFolders(): { name: string; time: string; partial: boolean }[] {
  const root = outRoot();
  if (!root) return [];
  let names: fs.Dirent[];
  try { names = fs.readdirSync(/*turbopackIgnore: true*/ root, { withFileTypes: true }); } catch { return []; }
  return names.filter((d) => d.isDirectory() && FOLDER.test(d.name)).map((d) => parseBackupFolder(d.name))
    .filter((f): f is { name: string; time: string; partial: boolean } => !!f.time).sort((a, b) => (a.time < b.time ? 1 : -1));
}

/** A zone's folder inside a local backup, only when it really is inside OUTPUT_DIR. */
function localZoneDir(folder: string, zoneName: string): string | null {
  const root = outRoot();
  if (!root || !FOLDER.test(folder)) return null;
  const dir = path.resolve(root, folder, zoneFolder(zoneName));
  if (!dir.startsWith(root + path.sep)) return null;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    return fs.realpathSync(/*turbopackIgnore: true*/ dir).startsWith(root + path.sep) ? dir : null;
  } catch { return null; }
}

function readLocal(dir: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.tf') || SKIP.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (fs.statSync(p).size > MAX_FILE) continue;
    out.push({ name: ent.name, text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

/** The files of a zone in one local folder (none: null). */
export function readLocalZone(folder: string, zoneName: string): { name: string; text: string }[] | null {
  const dir = localZoneDir(folder, zoneName);
  return dir ? readLocal(dir) : null;
}

/** Zones (folder names) in a local backup folder. */
export function localZones(folder: string): string[] {
  const root = outRoot();
  if (!root || !FOLDER.test(folder)) return [];
  try {
    return fs.readdirSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, folder), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'account' && !d.name.startsWith('.') && !d.name.startsWith('_')).map((d) => d.name);
  } catch { return []; }
}

// ── Buckets ─────────────────────────────────────────────────────────────────

export interface Store { id: string; label: string; target: BucketTarget }

/** Every approved bucket of the stored credentials (account sets' storage, and storage-only credentials). */
export async function bucketStores(): Promise<Store[]> {
  const out: Store[] = [];
  const seen = new Set<string>();
  for (const o of await listCredentialOptions()) {
    const kinds: { kind: 'r2' | 'aws'; buckets: string[] }[] = o.kind === 'cloudflare'
      ? (['r2', 'aws'] as const).flatMap((k) => (o.storage?.[k]?.length ? [{ kind: k, buckets: o.storage[k]! }] : []))
      : o.kind === 'r2' || o.kind === 'aws' ? [{ kind: o.kind, buckets: o.buckets ?? [] }] : [];
    if (!kinds.length) continue;
    let cred: Credential;
    try { cred = await credentialForRun(o.id, o.kind); } catch { continue; }
    for (const k of kinds) {
      const c = cred.kind === 'cloudflare' ? (() => { try { return storageOf(cred, k.kind); } catch { return null; } })() : cred;
      if (!c) continue;
      for (const bucket of k.buckets) {
        if (!/^[A-Za-z0-9._-]{1,63}$/.test(bucket)) continue;
        let target: BucketTarget;
        try { target = await bucketTarget(c, bucket); } catch { continue; }
        const key = `${target.kind}:${target.endpoint}:${bucket}:${target.prefix}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: `${o.id}:${k.kind}:${bucket}`, label: `${k.kind === 'r2' ? 'R2' : 'S3'} ${bucket}`, target });
      }
    }
  }
  return out;
}

/** Backup folders in a bucket, newest first. */
export async function bucketFolders(t: BucketTarget): Promise<{ name: string; time: string; partial: boolean }[]> {
  const { folders } = await listObjects(t, t.prefix, '/');
  return folders.map((f) => parseBackupFolder(f.slice(t.prefix.length).replace(/\/$/, '')))
    .filter((f): f is { name: string; time: string; partial: boolean } => !!f.time && FOLDER.test(f.name)).sort((a, b) => (a.time < b.time ? 1 : -1));
}

/** Zones (folder names) in a bucket's backup folder. */
export async function bucketZones(t: BucketTarget, folder: string): Promise<string[]> {
  const { folders } = await listObjects(t, `${t.prefix}${folder}/`, '/');
  return folders.map((f) => f.slice(`${t.prefix}${folder}/`.length).replace(/\/$/, '')).filter((z) => z && z !== 'account' && !z.startsWith('_'));
}

/** A zone's .tf files in a bucket's backup folder (none: null). */
export async function readBucketZone(t: BucketTarget, folder: string, zoneName: string, keys?: string[]): Promise<{ name: string; text: string }[] | null> {
  const base = `${t.prefix}${folder}/${zoneFolder(zoneName)}/`;
  const list = keys ?? (await listObjects(t, base)).keys.map((k) => k.key);
  const tf = list.filter((k) => k.startsWith(base) && k.endsWith('.tf') && !k.slice(base.length).includes('/') && !SKIP.has(k.slice(base.length)));
  if (!tf.length) return null;
  const files: { name: string; text: string }[] = [];
  for (let i = 0; i < tf.length; i += 6) {
    files.push(...await Promise.all(tf.slice(i, i + 6).map(async (k) => ({ name: k.slice(base.length), text: await getObject(t, k) }))));
  }
  return files.filter((f) => f.text.length <= MAX_FILE);
}

// ── One zone's backups ──────────────────────────────────────────────────────

/** How many folders of each place are looked through for one zone. */
const FOLDERS_PER_STORE = 40;

/**
 * The backups that hold a zone, newest first: local folders and bucket folders. `accountName`
 * (when known) narrows bucket folders to that account's.
 */
export async function zoneBackups(zoneName: string, accountName?: string | null): Promise<{ backups: BackupRef[]; problems: string[] }> {
  const backups: BackupRef[] = [];
  const problems: string[] = [];
  for (const f of localFolders().slice(0, 200)) {
    if (localZoneDir(f.name, zoneName)) backups.push({ ref: `local:${f.name}`, folder: f.name, time: f.time, partial: f.partial, where: 'This server' });
  }
  const acct = accountName ? `${accountFolder(accountName)}_` : '';
  let stores: Store[] = [];
  try { stores = await bucketStores(); } catch (err) { problems.push(`Buckets could not be listed: ${err instanceof Error ? err.message : String(err)}`); }
  await Promise.all(stores.map(async (s) => {
    try {
      const all = await bucketFolders(s.target);
      const mine = acct && all.some((f) => f.name.startsWith(acct)) ? all.filter((f) => f.name.startsWith(acct)) : all;
      for (const f of mine.slice(0, FOLDERS_PER_STORE)) {
        const { keys } = await listObjects(s.target, `${s.target.prefix}${f.name}/${zoneFolder(zoneName)}/`);
        if (keys.some((k) => k.key.endsWith('.tf'))) backups.push({ ref: `bucket:${s.id}:${f.name}`, folder: f.name, time: f.time, partial: f.partial, where: s.label });
      }
    } catch (err) { problems.push(`${s.label}: ${err instanceof Error ? err.message : String(err)}`); }
  }));
  backups.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.where.localeCompare(b.where)));
  return { backups, problems };
}

/** Reads one backup of a zone by its ref (from zoneBackups). */
export async function readZoneBackup(ref: string, zoneName: string): Promise<BackupFiles> {
  const local = /^local:([A-Za-z0-9_-]{1,200})$/.exec(ref);
  if (local) {
    const f = parseBackupFolder(local[1]);
    const files = f.time ? readLocalZone(local[1], zoneName) : null;
    if (!files) throw new HttpError(404, `That backup of ${zoneName} is not on this server`);
    return { ref: { ref, folder: local[1], time: f.time!, partial: f.partial, where: 'This server' }, files };
  }
  const b = /^bucket:([A-Za-z0-9_-]{1,64}):(r2|aws):([A-Za-z0-9._-]{1,63}):([A-Za-z0-9_-]{1,200})$/.exec(ref);
  if (!b) throw new HttpError(400, 'Unknown backup');
  const f = parseBackupFolder(b[4]);
  if (!f.time) throw new HttpError(400, 'Unknown backup');
  const store = (await bucketStores()).find((s) => s.id === `${b[1]}:${b[2]}:${b[3]}`);
  if (!store) throw new HttpError(404, 'That bucket is not approved on any stored credential');
  const files = await readBucketZone(store.target, b[4], zoneName);
  if (!files) throw new HttpError(404, `That backup has no Terraform files for ${zoneName}`);
  return { ref: { ref, folder: b[4], time: f.time, partial: f.partial, where: store.label }, files };
}
