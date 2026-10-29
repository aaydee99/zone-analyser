import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export const APP_ROOT = process.cwd();
// On Vercel the app folder is read-only: only the temporary folder can be written (and it is
// per instance; the worker keeps everything that must last).
export const DATA_DIR = process.env.CONSOLE_DATA_DIR
  ? path.resolve(process.env.CONSOLE_DATA_DIR)
  : process.env.VERCEL ? path.join(os.tmpdir(), 'backup-console') : path.join(APP_ROOT, 'data');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const RUNNER_DIR = path.join(APP_ROOT, 'runner');
export const RUNNER_SCRIPT = path.join(RUNNER_DIR, 'backup.js');
// Backups stay inside the console's own data folder unless a run says otherwise.
export const DEFAULT_OUTPUT_DIR = path.join(DATA_DIR, 'backups');

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write-then-rename so a crash never leaves a half-written vault or settings file. */
export function writeJsonAtomic(file: string, value: unknown) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const newId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
