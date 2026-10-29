import 'server-only';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, ensureDir, readJson, writeJsonAtomic } from './store';
import { HttpError } from './http';
import { findExecutable, systemPath } from './syspath';
import { verifyDetached } from './openpgp';

// HashiCorp's release-signing key (https://www.hashicorp.com/trust/security).
// terraform's SHA256SUMS must carry a valid signature from it or one of its certified subkeys.
const HASHICORP_FINGERPRINT = 'C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F';
const HASHICORP_KEY_URL = 'https://www.hashicorp.com/.well-known/pgp-key.txt';
// cf-terraforming publishes only checksums.txt (no signature), so it is checksum-verified only.

// Console-managed copies of terraform and cf-terraforming, downloaded from the
// official release servers into <data>/tools/bin, checksum-verified, and put
// first on PATH for every backup run — nothing is installed system-wide.

export type ToolName = 'terraform' | 'cf-terraforming';
export const TOOL_NAMES: ToolName[] = ['terraform', 'cf-terraforming'];

export const TOOLS_BIN = path.join(DATA_DIR, 'tools', 'bin');
const MANIFEST = path.join(DATA_DIR, 'tools', 'manifest.json');
const EXE = process.platform === 'win32' ? '.exe' : '';

interface ManifestEntry { version: string; sha256: string; source: string; installedAt: string }
type Manifest = Partial<Record<ToolName, ManifestEntry>>;

export interface ToolStatus {
  name: ToolName;
  installed: boolean;
  version?: string;
  installedAt?: string;
  source?: string;
  path: string;
  latest?: string;
  updateAvailable?: boolean;
}

function platformPair() {
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform as string];
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386' }[process.arch as string];
  if (!os || !arch) throw new HttpError(500, `Unsupported platform ${process.platform}/${process.arch}`);
  return { os, arch };
}

const binPath = (t: ToolName) => path.join(TOOLS_BIN, `${t}${EXE}`);
const readManifest = () => readJson<Manifest>(MANIFEST, {});

async function fetchOk(url: string, timeout = 120_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'backup-console' }, cache: 'no-store' });
  if (!res.ok) throw new HttpError(502, `Download failed (${res.status}): ${url}`);
  return res;
}
const fetchText = async (url: string) => (await fetchOk(url, 20_000)).text();
const fetchBuf = async (url: string) => Buffer.from(await (await fetchOk(url)).arrayBuffer());
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function expectSum(sums: string, file: string): string {
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${file}`) || l.trim().split(/\s+/)[1] === file);
  if (!line) throw new HttpError(502, `No checksum published for ${file}`);
  return line.trim().split(/\s+/)[0].toLowerCase();
}

// ── Archive readers ─────────────────────────────────────────────────────────
function extractFromTarGz(archive: Buffer, wanted: string): Buffer {
  const tar = zlib.gunzipSync(archive);
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (s: number, n: number) => header.subarray(s, s + n).toString('utf8').replace(/\0.*$/s, '');
    const name = (field(345, 155) ? `${field(345, 155)}/` : '') + field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const body = off + 512;
    if ((type === '0' || type === '') && path.posix.basename(name) === wanted) return Buffer.from(tar.subarray(body, body + size));
    off = body + Math.ceil(size / 512) * 512;
  }
  throw new HttpError(502, `${wanted} not found in archive`);
}

function extractFromZip(zip: Buffer, wanted: string): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new HttpError(502, 'Not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (path.posix.basename(name) === wanted) {
      const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(dataStart, dataStart + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new HttpError(502, `Unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new HttpError(502, `${wanted} not found in archive`);
}

// ── Release discovery ──────────────────────────────────────────────────────
async function latestVersion(t: ToolName): Promise<string> {
  if (t === 'terraform') {
    const j = JSON.parse(await fetchText('https://checkpoint-api.hashicorp.com/v1/check/terraform')) as { current_version: string };
    return j.current_version;
  }
  const j = JSON.parse(await fetchText('https://api.github.com/repos/cloudflare/cf-terraforming/releases/latest')) as { tag_name: string };
  return j.tag_name.replace(/^v/, '');
}

function installedVersion(t: ToolName): string | undefined {
  const bin = binPath(t);
  if (!fs.existsSync(bin)) return undefined;
  const r = spawnSync(bin, t === 'terraform' ? ['version', '-json'] : ['version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (r.status !== 0) return undefined;
  if (t === 'terraform') {
    try { return JSON.parse(r.stdout).terraform_version as string; } catch { return undefined; }
  }
  return /v?(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
}

const g = globalThis as unknown as { __cfToolInstall?: Set<ToolName> };
const installing: Set<ToolName> = (g.__cfToolInstall ??= new Set());

export async function toolStatus(withLatest = false): Promise<ToolStatus[]> {
  const m = readManifest();
  return Promise.all(TOOL_NAMES.map(async (name) => {
    const version = installedVersion(name);
    const s: ToolStatus = {
      name, installed: !!version, version, path: binPath(name),
      installedAt: version ? m[name]?.installedAt : undefined, source: version ? m[name]?.source : undefined,
    };
    if (withLatest) {
      try {
        s.latest = await latestVersion(name);
        s.updateAvailable = !!version && version !== s.latest;
      } catch { /* offline */ }
    }
    return s;
  }));
}

export const isInstalling = (t: ToolName) => installing.has(t);

export async function installTool(t: ToolName): Promise<ToolStatus> {
  if (!TOOL_NAMES.includes(t)) throw new HttpError(400, 'Unknown tool');
  if (installing.has(t)) throw new HttpError(409, `${t} is already being installed`);
  installing.add(t);
  try {
    const { os, arch } = platformPair();
    const version = await latestVersion(t);
    let url: string;
    let sumsUrl: string;
    let file: string;
    if (t === 'terraform') {
      file = `terraform_${version}_${os}_${arch}.zip`;
      url = `https://releases.hashicorp.com/terraform/${version}/${file}`;
      sumsUrl = `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_SHA256SUMS`;
    } else {
      file = `cf-terraforming_${version}_${os}_${arch}.tar.gz`;
      url = `https://github.com/cloudflare/cf-terraforming/releases/download/v${version}/${file}`;
      sumsUrl = `https://github.com/cloudflare/cf-terraforming/releases/download/v${version}/checksums.txt`;
    }

    const [archive, sums] = await Promise.all([fetchBuf(url), fetchText(sumsUrl)]);
    if (t === 'terraform') {
      // The checksum file is only trustworthy if HashiCorp signed it. Their key is fetched
      // from a different host and must match the fingerprint pinned in this code.
      const [key, sig] = await Promise.all([fetchText(HASHICORP_KEY_URL), fetchBuf(`${sumsUrl}.sig`)]);
      try {
        verifyDetached(key, HASHICORP_FINGERPRINT, sig, Buffer.from(sums, 'utf8'));
      } catch (err) {
        throw new HttpError(502, `terraform ${version}: SHA256SUMS signature check failed — ${(err as Error).message}. Download discarded.`);
      }
    }
    const want = expectSum(sums, file);
    const got = sha256(archive);
    if (got !== want) throw new HttpError(502, `Checksum mismatch for ${file} — expected ${want}, got ${got}. Download discarded.`);

    const exeName = `${t}${EXE}`;
    const bin = file.endsWith('.zip') ? extractFromZip(archive, exeName) : extractFromTarGz(archive, exeName);

    ensureDir(TOOLS_BIN);
    const dest = binPath(t);
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, bin, { mode: 0o700 });
    fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);

    const m = readManifest();
    m[t] = { version, sha256: sha256(bin), source: url, installedAt: new Date().toISOString() };
    writeJsonAtomic(MANIFEST, m);

    const v = installedVersion(t);
    if (!v) throw new HttpError(500, `${t} was installed but does not run on this machine`);
    return { name: t, installed: true, version: v, path: dest, installedAt: m[t]!.installedAt, source: url };
  } finally {
    installing.delete(t);
  }
}

type Log = (message: string, level?: 'info' | 'ok' | 'warn') => void;

/**
 * Makes sure every tool is available before a run: uses the console-managed copy,
 * downloads it if missing, and only falls back to a system install when offline.
 */
export async function ensureTools(log: Log, isCancelled: () => boolean = () => false) {
  for (const t of TOOL_NAMES) {
    while (installing.has(t)) await new Promise((r) => setTimeout(r, 500));
    if (isCancelled()) return;
    const v = installedVersion(t);
    if (v) { log(`${t} v${v} (console-managed)`, 'ok'); continue; }
    log(`${t} is not provisioned yet — downloading the latest release…`);
    try {
      const s = await installTool(t);
      log(`${t} v${s.version} downloaded and checksum-verified`, 'ok');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const sys = findExecutable(t, systemPath());
      if (!sys) throw new Error(`${t} could not be downloaded (${msg}) and none is installed on the system`);
      log(`${t} download failed (${msg}) — using the system copy at ${sys}`, 'warn');
    }
  }
}

/** Where a run will find each tool: the managed copy first, then the system PATH. */
export function resolveTools() {
  return TOOL_NAMES.map((name) => {
    const managed = fs.existsSync(binPath(name)) ? binPath(name) : null;
    const system = findExecutable(name, systemPath());
    return { name, managed, system, effective: managed ?? system };
  });
}

export function removeTool(t: ToolName) {
  if (!TOOL_NAMES.includes(t)) throw new HttpError(400, 'Unknown tool');
  fs.rmSync(binPath(t), { force: true });
  const m = readManifest();
  delete m[t];
  writeJsonAtomic(MANIFEST, m);
}
