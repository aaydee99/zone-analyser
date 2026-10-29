import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DEFAULT_OUTPUT_DIR } from './store';
import { cachedSettings } from './settings';
import { HttpError } from './http';
import type { RunMeta } from './run-types';

export interface BackupFile { path: string; size: number }

const MAX_VIEW_BYTES = 2 * 1024 * 1024;

/** The run's backup folder, only if it sits inside that run's OUTPUT_DIR. */
function backupRoot(meta: RunMeta): string {
  const root = meta.summary.backupRoot;
  if (!root) throw new HttpError(404, 'This run did not create a backup folder');
  const out = path.resolve(meta.outputDir || cachedSettings().outputDir || DEFAULT_OUTPUT_DIR);
  const abs = path.resolve(root);
  if (!abs.startsWith(out + path.sep)) throw new HttpError(403, 'Backup folder is outside the output directory');
  if (!fs.existsSync(abs)) throw new HttpError(410, 'Backup folder no longer exists on the server');
  // Compare real paths too, so a link anywhere in the chain cannot lead elsewhere.
  const real = fs.realpathSync(abs);
  const realOut = fs.existsSync(out) ? fs.realpathSync(out) : out;
  if (!real.startsWith(realOut + path.sep)) throw new HttpError(403, 'Backup folder is outside the output directory');
  return real;
}

function walk(root: string): BackupFile[] {
  const out: BackupFile[] = [];
  const visit = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) visit(p);
      else if (ent.isFile()) out.push({ path: path.relative(root, p).split(path.sep).join('/'), size: fs.statSync(p).size });
    }
  };
  visit(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function listBackupFiles(meta: RunMeta) {
  const root = backupRoot(meta);
  return { root, files: walk(root) };
}

export function readBackupFile(meta: RunMeta, rel: string) {
  const root = backupRoot(meta);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new HttpError(400, 'Invalid path');
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isFile()) throw new HttpError(404, 'File not found');
  // lstat only checks the last segment; a symlinked or junction folder earlier in the
  // path could still point outside the backup. Resolve every link and re-check.
  if (!fs.realpathSync(abs).startsWith(root + path.sep)) throw new HttpError(404, 'File not found');
  const buf = fs.readFileSync(abs).subarray(0, MAX_VIEW_BYTES);
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: rel, size: st.size, truncated: st.size > MAX_VIEW_BYTES, binary, content: binary ? '' : buf.toString('utf8') };
}

// ── Minimal zip writer (deflate, no zip64 — backups are far below 4 GB) ──────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipBackup(meta: RunMeta): { name: string; data: Buffer } {
  const root = backupRoot(meta);
  const top = path.basename(root);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const f of walk(root)) {
    const raw = fs.readFileSync(path.join(root, ...f.path.split('/')));
    const comp = zlib.deflateRawSync(raw, { level: 6 });
    const name = Buffer.from(`${top}/${f.path}`, 'utf8');
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  const count = central.length / 2;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return { name: `${top}.zip`, data: Buffer.concat([...locals, cd, end]) };
}
