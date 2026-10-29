import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// PATH as the operating system currently defines it — not the possibly stale
// copy this server inherited when it started. Windows: machine + user Path
// from the registry (REG_EXPAND_SZ expanded). macOS/Linux: the login shell's
// PATH. The server's own PATH is appended as a fallback; duplicates dropped.

const WIN = process.platform === 'win32';
const CACHE_MS = 60_000;
let cache: { at: number; dirs: string[]; sources: PathSource[] } | null = null;

export interface PathSource { source: 'machine' | 'user' | 'login-shell' | 'process'; dirs: string[] }

function expandWin(s: string) {
  return s.replace(/%([^%]+)%/g, (m, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key ? process.env[key] ?? '' : m;
  });
}

function regPath(key: string): string[] {
  const r = spawnSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) return [];
  const line = r.stdout.split(/\r?\n/).find((l) => /^\s+Path\s+REG_(EXPAND_)?SZ\s+/i.test(l));
  if (!line) return [];
  const value = line.replace(/^\s+Path\s+REG_(EXPAND_)?SZ\s+/i, '');
  return split(expandWin(value));
}

function loginShellPath(): string[] {
  const shell = process.env.SHELL || '/bin/sh';
  const r = spawnSync(shell, ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? split(r.stdout) : [];
}

const split = (s: string) => s.split(path.delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);

function processPath(): string[] {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return split(process.env[key] ?? '');
}

export function systemPathSources(): PathSource[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.sources;
  const sources: PathSource[] = WIN
    ? [
      { source: 'machine', dirs: regPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment') },
      { source: 'user', dirs: regPath('HKCU\\Environment') },
      { source: 'process', dirs: processPath() },
    ]
    : [{ source: 'login-shell', dirs: loginShellPath() }, { source: 'process', dirs: processPath() }];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const s of sources) {
    for (const d of s.dirs) {
      const k = WIN ? d.toLowerCase().replace(/\\+$/, '') : d.replace(/\/+$/, '');
      if (!seen.has(k)) { seen.add(k); dirs.push(d); }
    }
  }
  cache = { at: Date.now(), dirs, sources };
  return sources;
}

/** Deduplicated system PATH directories, in precedence order. */
export function systemPath(): string[] {
  systemPathSources();
  return cache!.dirs;
}

/** First executable named `cmd` in `dirs` (PATHEXT-aware on Windows). */
export function findExecutable(cmd: string, dirs: string[]): string | null {
  const exts = WIN ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(p).isFile()) { if (!WIN) fs.accessSync(p, fs.constants.X_OK); return p; }
      } catch { /* not here */ }
    }
  }
  return null;
}
