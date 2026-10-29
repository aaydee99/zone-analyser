import 'server-only';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDir } from './store';

// First-run setup requires a one-time token that only someone with access to the
// server (its terminal or data folder) can read — a web page cannot create the
// first super admin, even if it reaches the console through DNS rebinding.

const FILE = () => path.join(DATA_DIR, 'setup-token.txt');
const g = globalThis as unknown as { __cfSetupToken?: string };

/** Returns this process's setup token, creating, printing and saving it on first use. */
export function setupToken(): string {
  if (!g.__cfSetupToken) {
    g.__cfSetupToken = crypto.randomBytes(18).toString('base64url');
    ensureDir(DATA_DIR);
    fs.writeFileSync(FILE(), `${g.__cfSetupToken}\n`, { mode: 0o600 });
    console.log([
      '',
      '  ┌──────────────────────────────────────────────────────────────┐',
      '  │  Backup Console first-run setup                              │',
      `  │  Setup token: ${g.__cfSetupToken.padEnd(47)}│`,
      `  │  (also saved to ${path.relative(process.cwd(), FILE()).padEnd(45)}│`,
      '  └──────────────────────────────────────────────────────────────┘',
      '',
    ].join('\n'));
  }
  return g.__cfSetupToken;
}

export function checkSetupToken(candidate: unknown): boolean {
  const want = Buffer.from(setupToken());
  const got = Buffer.from(typeof candidate === 'string' ? candidate.trim() : '');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Called once the first super admin exists. */
export function clearSetupToken() {
  g.__cfSetupToken = undefined;
  fs.rmSync(FILE(), { force: true });
}
