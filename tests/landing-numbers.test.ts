import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TF_ACCOUNT_TYPES, TF_ZONE_TYPES } from '@/lib/landing-numbers';

// The landing page shows these by hand (runner/backup.js is CommonJS, not importable there): recount
// the resource lists in the script, so a change to either fails here instead of drifting.
const src = readFileSync(new URL('../runner/backup.js', import.meta.url), 'utf8');

function count(list: string): number {
  const m = src.match(new RegExp(String.raw`\bconst ${list}\s*=\s*\[([^\]]*)\]`));
  assert.ok(m, `${list} not found in runner/backup.js`);
  const items = m[1].split(',').map((s) => s.replace(/\/\/.*$/gm, '').trim()).filter(Boolean);
  for (const it of items) assert.match(it, /^(['"`])cloudflare_[a-z0-9_]+\1$/, `${list}: unexpected entry ${it}`);
  assert.equal(new Set(items).size, items.length, `${list} has duplicates`);
  return items.length;
}

test('landing TF_ZONE_TYPES matches ZONE_RESOURCES in runner/backup.js', () => {
  assert.equal(TF_ZONE_TYPES, count('ZONE_RESOURCES'));
});

test('landing TF_ACCOUNT_TYPES matches ACCOUNT_RESOURCES in runner/backup.js', () => {
  assert.equal(TF_ACCOUNT_TYPES, count('ACCOUNT_RESOURCES'));
});
