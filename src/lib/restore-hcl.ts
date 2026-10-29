// Restore planning helpers: read cf-terraforming output, match audit-log changes to the
// exact resource blocks they touched, and build Terraform import blocks. Pure functions,
// no imports beyond data tables — shared by the server and tests.
import { IMPORT_ATTR_ALIASES, IMPORT_ID_FORMATS, NO_IMPORT_TYPES, SKIP_IMPORT } from './tf-import-ids';

export interface TfBlock {
  /** e.g. cloudflare_dns_record */
  type: string;
  /** e.g. terraform_managed_resource_<id>_0 */
  label: string;
  /** The Cloudflare ID cf-terraforming put in the label ("" when there is none). */
  labelId: string;
  address: string;
  file: string;
  text: string;
  /** Top-level `key = "string"` attributes. */
  attrs: Record<string, string>;
  /** Other resources this block references (addresses). */
  refs: string[];
}

const BLOCK_RE = /^resource "([A-Za-z0-9_]+)" "([A-Za-z0-9_-]+)" \{\s*$/;
const REF_RE = /\b(cloudflare_[a-z0-9_]+)\.(terraform_managed_resource_[A-Za-z0-9_-]+)\b/g;

function stringAttrs(block: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of block.matchAll(/^ {2}([a-z_0-9]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/gm)) {
    try { attrs[m[1]] = JSON.parse(m[2].split('$${').join('${').split('%%{').join('%{')); } catch { /* not a plain string */ }
  }
  return attrs;
}

/** Top-level resource blocks of a terraform-fmt'd file (cf-terraforming output: each block ends with "}" at column 0). */
export function parseBlocks(text: string, file: string): TfBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: TfBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = BLOCK_RE.exec(lines[i]);
    if (!head) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trimEnd() !== '}') j++;
    const body = lines.slice(i, Math.min(j, lines.length - 1) + 1).join('\n');
    const address = `${head[1]}.${head[2]}`;
    out.push({
      type: head[1], label: head[2], address, file, text: body, attrs: stringAttrs(body),
      labelId: head[2].replace(/^terraform_managed_resource_/, '').replace(/_\d+$/, ''),
      refs: [...new Set([...body.matchAll(REF_RE)].map((m) => `${m[1]}.${m[2]}`))].filter((a) => a !== address),
    });
    i = j;
  }
  return out;
}

/**
 * Why a backup block must not be given to Terraform (null when it is safe). A restore runs
 * Terraform on the console host with real keys, and the bucket's content is not trusted: anyone
 * who can write to it could add code. Backups (cf-terraforming output) only hold literal values
 * of cloudflare_* resources, so anything else is refused:
 *  - other resource types (terraform_data, null_resource, local_file … run or write things);
 *  - provisioner / connection blocks and a provider override (`provider = …`);
 *  - template interpolation (`${…}`, `%{…}` — backups escape them as `$${` / `%%{`);
 *  - function calls (file(), templatefile(), … read local files into what is sent to Cloudflare).
 */
export function unsafeBlock(b: Pick<TfBlock, 'type' | 'text'>): string | null {
  if (!/^cloudflare_[a-z0-9_]+$/.test(b.type)) return `resource type ${b.type} is not a Cloudflare resource`;
  const body = b.text.split('\n').slice(1).join('\n');
  if (/^\s*(provisioner|connection)\b/m.test(body)) return 'it contains a provisioner / connection block';
  if (/^\s*provider\s*=/m.test(body)) return 'it overrides the provider';
  if (/(^|[^$])\$\{|(^|[^%])%\{/.test(body)) return 'it contains template interpolation';
  // Function calls outside string literals (heredoc bodies are left out: they hold literal text).
  const code = body.replace(/<<-?([A-Z_]+)\n[\s\S]*?\n\s*\1\s*$/gm, '""').replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  const call = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(code);
  if (call) return `it calls the function ${call[1]}()`;
  return null;
}

/** "<Account>_<YYYYMMDD>_<HHMMSS>[_partial]" (backup.js BACKUP_ROOT) → its UTC time. */
export function parseBackupFolder(name: string): { name: string; time: string | null; partial: boolean } {
  const m = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(_partial)?$/.exec(name);
  if (!m) return { name, time: null, partial: false };
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return { name, time: Number.isNaN(t) ? null : new Date(t).toISOString(), partial: !!m[7] };
}

// ── Import IDs (same rules as backup.js importIdFor, minus its API lookups) ─────

export function importIdFor(b: Pick<TfBlock, 'type' | 'labelId' | 'attrs'>, scope: { accountId: string; zoneId: string }): { id?: string; skip?: string } {
  if (NO_IMPORT_TYPES.has(b.type)) return { skip: 'the provider does not support import for this type' };
  if (SKIP_IMPORT[b.type]) return { skip: SKIP_IMPORT[b.type] };
  // The provider imports only the account-level organization; a zone-level one cannot be imported.
  if (b.type === 'cloudflare_zero_trust_organization' && b.attrs.zone_id && !b.attrs.account_id) return { skip: 'the provider imports only the account-level organization' };
  const format = IMPORT_ID_FORMATS[b.type];
  if (!format) return { skip: 'no documented import ID format' };
  const a = b.attrs;
  const acct = a.account_id || scope.accountId;
  const zone = a.zone_id || scope.zoneId;
  const tokens = [...format.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  const parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const isLast = i === tokens.length - 1;
    let v: string | undefined;
    if (tok === '{accounts|zones}/{account_id|zone_id}') v = a.account_id ? `accounts/${a.account_id}` : `zones/${zone}`;
    else if (tok === 'zone_id') v = zone;
    else if (tok === 'account_id') v = acct;
    else if (tok === 'jurisdiction') v = a.jurisdiction || 'default';
    else if (IMPORT_ATTR_ALIASES[b.type]?.[tok]) v = a[IMPORT_ATTR_ALIASES[b.type][tok]];
    else if (a[tok]) v = a[tok];
    else if (isLast && b.labelId && b.labelId !== acct && b.labelId !== zone) v = b.labelId;
    if (!v) return { skip: `could not determine <${tok}> for the import ID` };
    parts.push(v);
  }
  return { id: parts.join('/') };
}

const hclString = (s: string) => JSON.stringify(s).split('${').join('$${').split('%{').join('%%{');
export const importBlock = (address: string, id: string) => `import {\n  to = ${address}\n  id = ${hclString(id)}\n}\n`;

// ── Matching audit changes to blocks ───────────────────────────────────────────

export interface AuditChangeRef {
  id: string;
  time: string;
  zoneId: string;
  resourceId: string;
  resourceType: string;
  product: string;
  actionType: string;
  result: string;
  method: string;
  uri: string;
  /** Field-level detail; for a creation, the new object's values (name, type …). */
  changes?: { path: string; new?: string }[];
}

// API calls log /client/v4/…; dashboard actions can log the dashboard's /api/v4/… path.
const pathOf = (uri: string) => (uri || '').split('?')[0].replace(/^\/(?:client|api)\/v4(?=\/)/, '');

/** The entry is for this zone: its zone field, or — when Cloudflare leaves that empty — its request path. */
export function inZone(c: Pick<AuditChangeRef, 'zoneId' | 'uri'>, zoneId: string): boolean {
  if (c.zoneId) return c.zoneId === zoneId;
  return new RegExp(`^/zones/${zoneId}(?:/|$)`).test(pathOf(c.uri));
}

/** A change to rules inside a ruleset (".../rulesets/<id>/rules/<rule>"): the ruleset itself still exists. */
const RULE_PATH = /\/rulesets\/(?:[^/]+|phases\/[a-z0-9_]+\/entrypoint)\/rules(?:\/|$)/;

/** create / update / delete, from Cloudflare's action type or, failing that, the HTTP method. */
const verb = (c: Pick<AuditChangeRef, 'actionType' | 'method'>) => {
  const t = (c.actionType || '').toLowerCase();
  if (/^(delete|remove)/.test(t) || (!t && c.method === 'DELETE')) return 'delete';
  if (/^(create|add)/.test(t) || (!t && c.method === 'POST')) return 'create';
  return t || 'update';
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Cloudflare documents create / update / delete; accept close variants rather than drop a real change.
const WRITE_ACTION = /^(create|add|update|edit|modify|change|replace|set|delete|remove)/;
// Writes that change no configuration a backup holds: cache purges, exports and scans,
// analytics and log queries, token checks.
const NOT_CONFIG = [/\/purge_cache\b/, /\/dns_records\/(export|scan)\b/, /\/analytics\b/, /\/graphql\b/, /\/logs\//, /\/tokens\/verify\b/];

/**
 * A successful create, update or delete of configuration. Reads — every GET a backup run
 * (cf-terraforming, API lookups) or this console makes — and failed requests are not
 * something to restore.
 */
export function isConfigChange(c: Pick<AuditChangeRef, 'result' | 'method' | 'actionType' | 'uri'>): boolean {
  if (c.result === 'failure') return false;
  const method = (c.method || '').toUpperCase();
  if (READ_METHODS.has(method)) return false;
  if (!WRITE_ACTION.test((c.actionType || '').toLowerCase()) && !WRITE_METHODS.has(method)) return false;
  const p = pathOf(c.uri);
  return !NOT_CONFIG.some((re) => re.test(p));
}

/** The block(s) of the backup an audit entry changed. */
export function blocksForChange(c: AuditChangeRef, blocks: TfBlock[], scope: { accountId: string; zoneId: string }): TfBlock[] {
  const p = pathOf(c.uri);
  const setting = /\/zones\/[^/]+\/settings\/([a-z0-9_]+)/.exec(p)?.[1];
  const phase = /\/rulesets\/phases\/([a-z0-9_]+)/.exec(p)?.[1];
  const ids = new Set([c.resourceId].filter((x) => x && x !== scope.zoneId && x !== scope.accountId));
  const exact = blocks.filter((b) => (b.labelId && ids.has(b.labelId)) || (b.attrs.id && ids.has(b.attrs.id))
    || (setting && b.type === 'cloudflare_zone_setting' && b.attrs.setting_id === setting)
    || (phase && b.type === 'cloudflare_ruleset' && b.attrs.phase === phase));
  if (exact.length) return exact;
  // Fallback: the request path names the object ("/dns_records/<id>", "/pagerules/<id>").
  return blocks.filter((b) => b.labelId.length >= 8 && b.labelId !== scope.zoneId && b.labelId !== scope.accountId && p.split('/').includes(b.labelId));
}

export type CandidateMode = 'revert' | 'recreate' | 'created-after-backup' | 'not-in-backup' | 'matches' | 'unchecked' | 'delete';

export interface RestoreCandidate {
  /** Stable key: the block address, or "audit:<resource>" when no block matches. */
  key: string;
  mode: CandidateMode;
  address?: string;
  type?: string;
  /** Import ID for `revert`; why import is impossible otherwise. */
  importId?: string;
  importSkip?: string;
  /** Audit entry IDs that touched it, newest first. */
  changeIds: string[];
  lastAction: string;
  lastTime: string;
  /** Deleted after the backup, then created again under this new ID: imported, not created twice. */
  recreatedAs?: string;
  /** Set by "Compare everything": found by comparing the live zone with the backup. */
  found?: 'compare';
  /** Compare: live value → backup value, field by field. */
  drift?: { path: string; old?: string; new?: string }[];
  /** Compare: why this resource could not be checked. */
  reason?: string;
  /** delete: the backup has this resource type (false: the type is not in the backup at all). */
  typeInBackup?: boolean;
}

/** Does a creation re-create the object this backup block describes (same name, and type when it has one)? */
function sameIdentity(c: AuditChangeRef, b: TfBlock): boolean {
  const val = (k: string) => c.changes?.find((f) => f.path === k)?.new;
  if (!b.attrs.name || val('name') !== b.attrs.name) return false;
  return !b.attrs.type || val('type') === b.attrs.type;
}

/**
 * Groups the zone's configuration changes (see isConfigChange) by the backup block they touched and decides how each
 * can be restored:
 *  - revert:  the object still exists → import it, plan reverts it to the backup
 *  - recreate: it was deleted after the backup → plan creates it from the backup
 *  - created-after-backup: not in the backup (would need deleting — not done)
 *  - not-in-backup: the backup has no block for it (type not exported, account-level…)
 */
export function restoreCandidates(changes: AuditChangeRef[], blocks: TfBlock[], scope: { accountId: string; zoneId: string }): RestoreCandidate[] {
  const ok = changes.filter((c) => inZone(c, scope.zoneId) && isConfigChange(c))
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0)); // newest first
  const byKey = new Map<string, RestoreCandidate>();
  for (const c of ok) {
    const hits = blocksForChange(c, blocks, scope);
    if (!hits.length) {
      const key = `audit:${c.resourceType}:${c.resourceId || pathOf(c.uri)}`;
      const cur = byKey.get(key);
      if (cur) { cur.changeIds.push(c.id); if (verb(c) === 'create') cur.mode = 'created-after-backup'; continue; }
      byKey.set(key, { key, mode: verb(c) === 'create' ? 'created-after-backup' : 'not-in-backup', changeIds: [c.id], lastAction: verb(c), lastTime: c.time });
      continue;
    }
    for (const b of hits) {
      const cur = byKey.get(b.address);
      if (cur) { cur.changeIds.push(c.id); continue; }
      // Deleting a rule changes its ruleset (revert it); only deleting the object itself means recreate.
      // SKIP_IMPORT types (snippets) are always written back by create, which overwrites in place.
      const deleted = (verb(c) === 'delete' && !(b.type === 'cloudflare_ruleset' && RULE_PATH.test(pathOf(c.uri)))) || !!SKIP_IMPORT[b.type];
      const imp = deleted ? {} : importIdFor(b, scope);
      byKey.set(b.address, {
        key: b.address, address: b.address, type: b.type, mode: deleted ? 'recreate' : 'revert',
        importId: imp.id, importSkip: imp.skip, changeIds: [c.id], lastAction: verb(c), lastTime: c.time,
      });
    }
  }
  // A deleted object may already have been created again (by hand, or by an earlier restore)
  // under a new ID. Creating it once more would duplicate it: import the new one instead.
  const blocksByAddr = new Map(blocks.map((b) => [b.address, b]));
  for (const cand of byKey.values()) {
    if (cand.mode !== 'recreate' || !cand.address) continue;
    const b = blocksByAddr.get(cand.address)!;
    const remade = ok.find((c) => verb(c) === 'create' && c.time > cand.lastTime && c.resourceId && !blocksForChange(c, blocks, scope).length && sameIdentity(c, b));
    if (!remade) continue;
    const imp = importIdFor({ ...b, labelId: remade.resourceId, attrs: { ...b.attrs, id: '' } }, scope);
    Object.assign(cand, { mode: 'revert', recreatedAs: remade.resourceId, importId: imp.id, importSkip: imp.skip, lastAction: 'create', lastTime: remade.time });
    cand.changeIds.unshift(remade.id);
    byKey.delete(`audit:${remade.resourceType}:${remade.resourceId}`);
  }
  return [...byKey.values()];
}

/** The selected blocks plus every block they reference (Terraform needs them declared). */
export function withDependencies(selected: string[], blocks: TfBlock[]): { address: string; dependency: boolean }[] {
  const byAddr = new Map(blocks.map((b) => [b.address, b]));
  const out = new Map<string, boolean>(selected.map((a) => [a, false]));
  const queue = [...selected];
  while (queue.length) {
    const b = byAddr.get(queue.shift()!);
    for (const r of b?.refs ?? []) if (!out.has(r) && byAddr.has(r)) { out.set(r, true); queue.push(r); }
  }
  return [...out].map(([address, dependency]) => ({ address, dependency }));
}

// ── Compare everything: reading `terraform plan -json` errors ──────────────────

/** Where each block / import block sits in the generated files, to tie an error to its resource. */
export interface ConfigRange { file: string; start: number; end: number; address: string }

/** Lays blocks out one after another and records each one's line range. */
export function layout(parts: { address: string; text: string }[], file: string): { text: string; ranges: ConfigRange[] } {
  const ranges: ConfigRange[] = [];
  const lines: string[] = [];
  for (const p of parts) {
    const body = p.text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    ranges.push({ file, start: lines.length + 1, end: lines.length + body.length, address: p.address });
    lines.push(...body, '');
  }
  return { text: `${lines.join('\n')}\n`, ranges };
}

// How Terraform / the Cloudflare provider say an object to import is gone.
const MISSING_RE = /non-existent remote object|does not exist|not found|could not be found|no longer exists|\b404\b|was deleted/i;

export interface PlanError { address: string | null; missing: boolean; message: string }

/**
 * Error diagnostics from `terraform plan -json` output, each tied to the resource it is about: by
 * its address, its line in the generated files, or — for provider errors that name neither, e.g.
 * `GET …/dns_records/<id>: 404` — the object ID being imported (`ids`: address → import ID).
 */
export function planErrors(stdout: string, ranges: ConfigRange[], ids: Map<string, string> = new Map()): PlanError[] {
  const out: PlanError[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let j: { type?: string; diagnostic?: { severity?: string; summary?: string; detail?: string; address?: string; range?: { filename?: string; start?: { line?: number } } } };
    try { j = JSON.parse(line); } catch { continue; }
    const d = j.diagnostic;
    if (j.type !== 'diagnostic' || d?.severity !== 'error') continue;
    const text = `${d.summary ?? ''}: ${d.detail ?? ''}`;
    const file = (d.range?.filename ?? '').replace(/\\/g, '/').split('/').pop();
    const ln = d.range?.start?.line ?? 0;
    const byRange = file && ln ? ranges.find((r) => r.file === file && ln >= r.start && ln <= r.end)?.address : undefined;
    const named = /\b(cloudflare_[a-z0-9_]+\.[A-Za-z0-9_-]+)/.exec(text)?.[1];
    const last = (id: string) => id.split('/').pop() ?? '';
    // The ID deepest in the URL names the object: /zones/<zone>/dns_records/<record> is the record,
    // not one of the per-zone singletons whose import ID is the zone ID alone.
    const at = (id: string) => (last(id).length >= 6 ? text.lastIndexOf(`/${last(id)}`) : -1);
    const deepest = Math.max(-1, ...[...ids.values()].map(at));
    const byId = deepest < 0 ? [] : [...ids].filter(([, id]) => at(id) === deepest);
    out.push({ address: d.address?.replace(/\[.*\]$/, '') || byRange || named || (byId.length === 1 ? byId[0][0] : null), missing: MISSING_RE.test(text), message: text.replace(/\s+/g, ' ').trim().slice(0, 400) });
  }
  return out;
}

// ── Cloudflare provider read-back quirks ──────────────────────────────────────
// Values the provider reads back from Cloudflare that mean the same as the backup's value, though
// they differ as text. Without these, a compare offers them for revert every time and the check
// after an apply never passes. Each is a known, specific case — anything else still counts.

const unset = (v?: string) => v === undefined || v === '' || v === 'null' || v === '{}' || v === '[]';

/** type → top-level attribute → (live, backup) are equivalent. */
export const PROVIDER_EQUIVALENT: Record<string, Record<string, (live: string | undefined, backup: string | undefined) => boolean>> = {
  // Turning DNSSEC on/off goes through pending states until the registrar has (or drops) the DS record.
  cloudflare_zone_dnssec: {
    status: (l, b) => (b === 'active' && l === 'pending') || (b === 'disabled' && l === 'pending-disabled'),
  },
  // "none" (the default) is read back as unset.
  cloudflare_api_shield_schema_validation_settings: {
    validation_default_mitigation_action: (l, b) => b === 'none' && unset(l),
  },
  // Snippet metadata (main_module) is not returned on read; the snippet code itself is compared.
  cloudflare_snippet: { metadata: (l) => unset(l) },
  // Accepted on write, never returned (backups no longer write it; older backups still have it).
  cloudflare_bot_management: { bot_preference_sync_enabled: (l) => unset(l) },
  // Only enabled headers are read back: a disabled one on one side, absent on the other, is the same.
  cloudflare_managed_transforms: { managed_request_headers: disabledOrAbsent, managed_response_headers: disabledOrAbsent },
};

function disabledOrAbsent(l?: string, b?: string) {
  const off = (v?: string) => { try { return (JSON.parse(v ?? '') as { enabled?: unknown }).enabled === false; } catch { return false; } };
  return (unset(l) && off(b)) || (unset(b) && off(l));
}

/** Is this live → backup field difference only a provider read-back quirk? */
export function isProviderEquivalent(type: string, f: { path: string; old?: string; new?: string }): boolean {
  const rule = PROVIDER_EQUIVALENT[type]?.[f.path.split(/[.[]/)[0]];
  return !!rule && rule(f.old, f.new);
}

/** From apply output: address → attributes the provider read back inconsistently ("was …, but now null"). */
export function inconsistentAttrs(out: string): Map<string, Set<string>> {
  const flat = out.replace(/[│╷╵]/g, ' ').replace(/\s+/g, ' ');
  const found = new Map<string, Set<string>>();
  for (const m of flat.matchAll(/Provider produced inconsistent result after apply When applying changes to (\S+?), provider .*? produced an unexpected new value: \.([A-Za-z0-9_]+)/g)) {
    if (!found.has(m[1])) found.set(m[1], new Set());
    found.get(m[1])!.add(m[2]);
  }
  return found;
}

/** Errors in apply output other than "inconsistent result after apply". */
export function otherErrors(out: string): number {
  return (out.match(/Error: .*/g) ?? []).filter((l) => !l.includes('Provider produced inconsistent result after apply')).length;
}

/** Blocks that reference any of `gone`, directly or through others (they cannot be planned without it). */
export function dependents(gone: Set<string>, blocks: TfBlock[]): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of blocks) if (!out.has(b.address) && !gone.has(b.address) && b.refs.some((r) => gone.has(r) || out.has(r))) { out.add(b.address); grew = true; }
  }
  return out;
}

// ── Full revert: the live zone vs the backup ──────────────────────────────────

/** Per-zone singletons (zone settings, …) are labelled with the zone ID: never "extra". */
const isSingleton = (b: Pick<TfBlock, 'labelId'>, scope: { accountId: string; zoneId: string }) => !b.labelId || b.labelId === scope.zoneId || b.labelId === scope.accountId;

/** Same object under another ID: same type and name (and DNS type / ruleset phase when set). */
export function sameObject(b: TfBlock, l: TfBlock): boolean {
  if (b.type !== l.type || !b.attrs.name || b.attrs.name !== l.attrs.name) return false;
  for (const k of ['type', 'phase', 'kind']) if (b.attrs[k] && b.attrs[k] !== l.attrs[k]) return false;
  return true;
}

/** Live objects the backup does not have — deleted by a full revert. */
export function liveExtras(backup: TfBlock[], live: TfBlock[], scope: { accountId: string; zoneId: string }): TfBlock[] {
  const known = new Set(backup.map((b) => `${b.type}|${b.labelId}`));
  const seen = new Set<string>();
  return live.filter((l) => {
    const k = `${l.type}|${l.labelId}`;
    if (isSingleton(l, scope) || known.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Backup blocks deleted live whose object was created again under a new ID: the one extra with
 * the same identity is imported as that backup block (reverted), not deleted and re-created.
 * Ambiguous matches (two live records with the same name and type) are left alone.
 */
export function reusedExtras(missing: TfBlock[], extras: TfBlock[]): Map<string, TfBlock> {
  const out = new Map<string, TfBlock>();
  const taken = new Set<string>();
  for (const b of missing) {
    const hits = extras.filter((l) => sameObject(b, l) && !taken.has(l.address));
    const rivals = missing.filter((m) => m !== b && hits.some((h) => sameObject(m, h)));
    if (hits.length === 1 && !rivals.length) { out.set(b.address, hits[0]); taken.add(hits[0].address); }
  }
  return out;
}

/** A live block renamed so it cannot clash with a backup address: <type>.extra_<id>. */
export function asExtra(l: TfBlock, used: Set<string>): TfBlock {
  let label = `extra_${l.labelId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  for (let i = 2; used.has(`${l.type}.${label}`); i++) label = `extra_${l.labelId.replace(/[^A-Za-z0-9_-]/g, '_')}_${i}`;
  used.add(`${l.type}.${label}`);
  const text = l.text.replace(/^resource "([A-Za-z0-9_]+)" "[A-Za-z0-9_-]+" \{/, `resource "$1" "${label}" {`);
  return { ...l, label, address: `${l.type}.${label}`, text };
}
