#!/usr/bin/env node
'use strict';
// =============================================================================
// Cloudflare Terraform Backup Script  —  Provider v5 / cf-terraforming latest
// JavaScript (Node.js >= 18) port of backup.sh — same behaviour, same output.
// =============================================================================
//
// STRATEGY
// --------
// PRIMARY  → cf-terraforming generate  (produces .tf files only, no state/import)
// FALLBACK → Cloudflare REST API v4    (JSON dumps for everything else)
//
// cf-terraforming needs `terraform init` to have run in the target directory
// so the provider schema is available: provider.tf is written FIRST, terraform
// init runs ONCE per directory, then every generate call points
// --terraform-install-path at that initialised directory.
//
// SECURITY / RATE-LIMITING RULES: cloudflare_ruleset ONLY
// ---------------------------------------------------------
// cloudflare_filter / cloudflare_firewall_rule are NOT generated: the Firewall
// Rules and Filters APIs were sunset on 2025-06-15
// (https://developers.cloudflare.com/waf/reference/legacy/firewall-rules-upgrade/).
// Custom rules and rate limiting live in cloudflare_ruleset (phases
// http_request_firewall_custom / http_ratelimit).
//
// RULESET `rules` SAFETY NET
// ---------------------------
// Older cf-terraforming releases exported cloudflare_ruleset shells without
// their `rules` (cloudflare/cf-terraforming#801, closed 2025-06-24). Any
// kind="zone"/"account" ruleset block that still comes back WITHOUT `rules`
// gets its live rules fetched from the Rulesets API and written in, filtered
// against the provider schema. See injectRulesetRulesGap().
//
// RESOURCES THAT NEED --resource-id
// ----------------------------------
// cf-terraforming exits with "No resource IDs defined" for these unless the
// IDs are passed explicitly; the IDs are discovered via the API first
// (zone setting IDs, waiting room IDs, Worker script names, …). See
// generateResourceIds().
//
// LIST ITEMS
// ----------
// cf-terraforming does not follow cursor pagination, so list items are
// fetched with cursor pagination (cfApiListCursor) and written as
// cloudflare_list_item resources (see writeListItems).
//
// API ERRORS ARE NEVER SAVED AS "EMPTY"
// --------------------------------------
// A JSON dump whose request failed is NOT written as []/{}; a
// <name>.json.error file is written instead, and every failing request is
// listed in <backup_root>/_api_errors.tsv. cf-terraforming's stderr for each
// resource type is kept in <dir>/_generate_errors.log.
//
// MULTI-ZONE SCOPE
// -----------------
// Every zone on the account is discovered (GET /zones?account.id=...) unless
// zone IDs are given on the command line or in ZONE_IDS. Account-level
// resources are backed up once per run, not once per zone.
//
// REQUIREMENTS
// ------------
//   node >= 18 (built-in fetch), cf-terraforming (>= v0.30.0), terraform >= 1.5
//   No npm packages. curl / jq / python3 are NOT needed by this version.
//
// USAGE
//   Edit CONFIGURATION below (or .env), then:
//     node backup.js                         every zone + account-level resources
//     node backup.js <zone_id> [<zone_id>…]  only these zones (space- or comma-separated)
//     node backup.js -z <zone_id> -z <id>    same, with flags
//     node backup.js --with-account <id>     these zones + account-level resources
//     node backup.js --import [<zone_id>…]   also write imports.tf (see IMPORT MODE)
//     node backup.js -h                      help
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Backups contain secrets-adjacent config (webhook URLs, tunnel/IdP settings,
// audit logs) — keep everything this script writes private to the owner.
process.umask(0o077);

const SCRIPT_DIR = __dirname;

// ── .env auto-load ────────────────────────────────────────────────────────────
// Looks for a .env file next to this script, or in the current directory, and
// loads it before the CONFIGURATION block below reads any variables — with the
// same rules as `set -a; source .env` in the bash version: values in .env
// override the environment, "double" and 'single' quotes, ${VAR}, ${VAR:-x},
// $VAR expansion, and trailing # comments. Never commit a filled-in .env.
function expandVars(s) {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, name, op, dflt, bare) => {
      if (bare) return process.env[bare] ?? '';
      const v = process.env[name];
      if (op === ':-') return v ? v : dflt;
      if (op === '-') return v !== undefined ? v : dflt;
      return v ?? '';
    });
}

function parseEnvValue(raw) {
  const LIT_DOLLAR = '\u0000';
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      let j = i + 1;
      let seg = '';
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\' && j + 1 < raw.length && '"\\$`'.includes(raw[j + 1])) {
          seg += raw[j + 1] === '$' ? LIT_DOLLAR : raw[j + 1];
          j += 2;
          continue;
        }
        seg += raw[j++];
      }
      out += expandVars(seg).split(LIT_DOLLAR).join('$');
      i = j + 1;
    } else if (c === "'") {
      const j = raw.indexOf("'", i + 1);
      out += raw.slice(i + 1, j < 0 ? raw.length : j);
      i = j < 0 ? raw.length : j + 1;
    } else if (/\s/.test(c)) {
      break; // end of the value; anything after is a comment
    } else {
      let j = i;
      let seg = '';
      while (j < raw.length && !/[\s"']/.test(raw[j])) {
        if (raw[j] === '\\' && j + 1 < raw.length) { seg += raw[j + 1]; j += 2; continue; }
        seg += raw[j++];
      }
      out += expandVars(seg);
      i = j;
    }
  }
  return out;
}

function loadDotEnv(file) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) process.env[m[1]] = parseEnvValue(m[2]);
  }
}

for (const candidate of [path.join(SCRIPT_DIR, '.env'), path.resolve('.env')]) {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    loadDotEnv(candidate);
    break;
  }
}

// ╔═════════════════════════════════════════════════════════════════════════════╗
// ║                        ★  CONFIGURATION  ★                                ║
// ╚═════════════════════════════════════════════════════════════════════════════╝
const E = process.env;
const envOr = (k, dflt) => (E[k] ? E[k] : dflt); // bash ${VAR:-default}

// ── Credentials ───────────────────────────────────────────────────────────────
// Populate from environment variables or a local .env file — never hardcode.
const CF_API_TOKEN = envOr('CF_API_TOKEN', '');
const CF_ACCOUNT_ID = envOr('CF_ACCOUNT_ID', '');

// ── Scope ─────────────────────────────────────────────────────────────────────
//   ZONE_STATUS_FILTER   "all" (default) or one Cloudflare zone status
//                        ("active", "pending", "initializing", "moved",
//                        "deactivated").
//   ZONE_STATUS_EXCLUDE  Space-separated statuses to skip even when
//                        ZONE_STATUS_FILTER=all. Default "moved".
//   ZONE_NAME_FILTER     Shell glob against the zone name, e.g. "*.example.com".
//   ZONE_IDS             Space- or comma-separated zone IDs; same as passing
//                        them on the command line (which overrides this).
//   BACKUP_ACCOUNT       Account-level resources: auto (default — all-zone runs
//                        or --with-account) | true (always) | false (never).
const ZONE_STATUS_FILTER = envOr('ZONE_STATUS_FILTER', 'all');
const ZONE_STATUS_EXCLUDE = E.ZONE_STATUS_EXCLUDE !== undefined ? E.ZONE_STATUS_EXCLUDE : 'moved';
const ZONE_NAME_FILTER = envOr('ZONE_NAME_FILTER', '*');
let ZONE_IDS = envOr('ZONE_IDS', '');
const BACKUP_ACCOUNT = envOr('BACKUP_ACCOUNT', 'auto');
//   BACKUP_MODE          generate (default) — Terraform config + JSON dumps only
//                        import             — also write imports.tf per Terraform
//                                             folder (see IMPORT MODE below).
//                        The --import / --generate-only / --mode flags override it.
const BACKUP_MODE = envOr('BACKUP_MODE', 'generate');
let IMPORT_MODE = false;

// ── Output ────────────────────────────────────────────────────────────────────
// A relative OUTPUT_DIR (e.g. "./cf_backups" in .env) is taken relative to this
// script's directory, not the shell's working directory.
let OUTPUT_DIR = envOr('OUTPUT_DIR', `${E.HOME || ''}/cf_backups`);
if (!path.isAbsolute(OUTPUT_DIR)) OUTPUT_DIR = `${SCRIPT_DIR}/${OUTPUT_DIR.replace(/^\.\//, '')}`;

// ── Terraform / Provider ──────────────────────────────────────────────────────
const TF_BINARY = 'terraform';
const CF_PROVIDER_VERSION = '~> 5.0';
const TF_MIN_VERSION = '1.5';

// ── Misc ──────────────────────────────────────────────────────────────────────
const AUDIT_LOG_HOURS = envOr('AUDIT_LOG_HOURS', '72');

// ── R2 Upload ─────────────────────────────────────────────────────────────────
const R2_ACCESS_KEY_ID = envOr('R2_ACCESS_KEY_ID', '');
const R2_SECRET_ACCESS_KEY = envOr('R2_SECRET_ACCESS_KEY', '');
const R2_BUCKET_NAME = envOr('R2_BUCKET_NAME', 'terraform-backup');
const R2_ENDPOINT = envOr('R2_ENDPOINT', '');
const R2_PREFIX = envOr('R2_PREFIX', '');
const R2_SKIP_UPLOAD = envOr('R2_SKIP_UPLOAD', 'true');

// ── R2 Bucket Lock ────────────────────────────────────────────────────────────
// Bucket-lock rules use the Cloudflare API (CF_API_TOKEN), not the R2 S3 keys.
// The bucket stays locked at rest; each run saves the bucket's current rules,
// unlocks just long enough to upload, then re-applies the rule set from
// R2_LOCK_RULES_FILE (JSON, top-level "rules") when that file exists and has
// rules — otherwise exactly the rules the bucket had before. The restore also
// runs on SIGINT/SIGTERM/SIGHUP and uncaught errors; if it fails, the run fails.
const R2_LOCK_RULES_FILE = `${SCRIPT_DIR}/r2_lock_rules.json`;

// ── AWS S3 Upload ─────────────────────────────────────────────────────────────
const AWS_ACCESS_KEY_ID = envOr('AWS_ACCESS_KEY_ID', '');
const AWS_SECRET_ACCESS_KEY = envOr('AWS_SECRET_ACCESS_KEY', '');
const AWS_S3_BUCKET = envOr('AWS_S3_BUCKET', 'carters-cloudflare-backups');
// Leave empty for auto-detection; set explicitly to skip the HEAD lookup.
let AWS_REGION = envOr('AWS_REGION', '');
const AWS_SKIP_UPLOAD = envOr('AWS_SKIP_UPLOAD', 'true');

// ── Upload requirement ────────────────────────────────────────────────────────
//   BACKUP_REQUIRE_UPLOAD  1/true — refuse to start unless R2 or AWS S3 upload
//                          is enabled (the local copy will not survive the run).
//                          0/false — never require it. Unset: required when
//                          GITHUB_ACTIONS=true (the console worker, whose disk
//                          is discarded with the job).
const REQUIRE_UPLOAD = E.BACKUP_REQUIRE_UPLOAD
  ? ['1', 'true', 'yes'].includes(E.BACKUP_REQUIRE_UPLOAD.toLowerCase())
  : E.GITHUB_ACTIONS === 'true';

// ╔═════════════════════════════════════════════════════════════════════════════╗
// ║                      END OF CONFIGURATION                                  ║
// ╚═════════════════════════════════════════════════════════════════════════════╝

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// ── Colours / logging ─────────────────────────────────────────────────────────
// Log helpers write to stderr; plain step output (what the bash version's
// inline Python printed) goes to stdout. Both are mirrored to the logfile once
// main() opens it.
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';
let LOG_FD = null;

function emit(stream, text) {
  stream.write(`${text}\n`);
  if (LOG_FD !== null) fs.writeSync(LOG_FD, `${text}\n`);
}
// The bash log helpers used `echo -e`, which renders backslash escapes in the
// message (e.g. the literal "\n" inside cf-terraforming error text).
// Windows paths (C:\Users\…\tools) are left as-is so their backslashes are not
// read as escapes.
const echoE = (s) => String(s).split(/([A-Za-z]:\\[^\s'"]*)/).map((part, i) => (i % 2 ? part
  : part.replace(/\\(\\|n|t|r|e|0[0-7]{0,3})/g, (m, c) => (
    c === '\\' ? '\\' : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === 'e' ? '\x1b'
      : String.fromCharCode(parseInt(c.slice(1) || '0', 8)))))).join('');
const logInfo = (m) => emit(process.stderr, `${BLUE}[INFO]${NC}  ${echoE(m)}`);
const logOk = (m) => emit(process.stderr, `${GREEN}[OK]${NC}    ${echoE(m)}`);
const logWarn = (m) => emit(process.stderr, `${YELLOW}[WARN]${NC}  ${echoE(m)}`);
const logError = (m) => emit(process.stderr, `${RED}[ERROR]${NC} ${echoE(m)}`);
const logSection = (m) => emit(process.stderr, `\n${CYAN}${BOLD}━━━  ${echoE(m)}  ━━━${NC}`);
const out = (m = '') => emit(process.stdout, m);

// =============================================================================
// SMALL UTILITIES (stand-ins for the shell tools the bash version used)
// =============================================================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pad2 = (n) => String(n).padStart(2, '0');

// `date -u` → "Sun Oct 25 15:40:21 UTC 2026"
function dateU(d = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
}
// `date -u '+%Y-%m-%dT%H:%M:%SZ'`
const isoZ = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
// `date -u '+%Y%m%d_%H%M%S'`
const stampU = (d = new Date()) => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}_`
  + `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;

// `command -v`
function which(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) return fs.existsSync(cmd) ? cmd : null;
  // Windows: PATH is ;-separated and executables carry a PATHEXT extension.
  const exts = process.platform === 'win32' ? ['', ...(E.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of (E.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch { /* not here */ }
    }
  }
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, ...opts });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Recursive file/dir listing (`find`).
function walk(dir, { dirs = false } = {}) {
  const res = [];
  const visit = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (dirs) res.push(p);
        visit(p);
      } else if (!dirs) {
        res.push(p);
      }
    }
  };
  visit(dir);
  return res;
}

// jq-compatible helpers ---------------------------------------------------------
// .a.b — null on missing keys / null input; throws when indexing a non-object.
function jqGet(v, keys) {
  for (const k of keys) {
    if (v === null || v === undefined) return null;
    if (!isObj(v)) throw new Error(`Cannot index ${Array.isArray(v) ? 'array' : typeof v} with "${k}"`);
    v = hasOwn(v, k) ? v[k] : null;
  }
  return v === undefined ? null : v;
}
// `a // b` — alternative on null/false/error.
function jqAlt(fn, alt) {
  try {
    const v = fn();
    return v === null || v === undefined || v === false ? alt : v;
  } catch {
    return alt;
  }
}
// `jq -r` output of one value.
const jqRaw = (v) => (v === null || v === undefined ? 'null' : typeof v === 'string' ? v : JSON.stringify(v));
// a value as rendered by `@tsv` (null → empty field)
const tsvVal = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
// `.[]?`
const jqIter = (v) => (Array.isArray(v) ? v : isObj(v) ? Object.values(v) : []);
// `length`
function jqLength(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string' || Array.isArray(v)) return v.length;
  if (isObj(v)) return Object.keys(v).length;
  if (typeof v === 'number') return Math.abs(v);
  return 0;
}
// `@uri` (RFC 3986 unreserved characters only)
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
// `.errors[0].message`
const errMessage = (o) => jqAlt(() => {
  const errs = jqGet(o, ['errors']);
  return Array.isArray(errs) && errs.length ? jqGet(errs[0], ['message']) : null;
}, null);
// Shell glob (bash `[[ x == $pattern ]]`) → RegExp
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const j = glob.indexOf(']', i + 1);
      if (j < 0) { re += '\\['; continue; }
      let cls = glob.slice(i + 1, j);
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
      re += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = j;
    } else re += escRe(c);
  }
  return new RegExp(`^${re}$`, 's');
}

// Terminate without the ABORTED banner (the bash version's plain `exit N`).
class ExitRequest extends Error {
  constructor(code) { super(`exit ${code}`); this.exitCode = code; }
}
const exitNow = (code) => { throw new ExitRequest(code); };

// =============================================================================
// PREREQS
// =============================================================================
function checkPrereqs() {
  logSection('Checking prerequisites');
  let fail = 0;

  for (const cmd of ['cf-terraforming', TF_BINARY]) {
    const p = which(cmd);
    if (p) logOk(`${cmd} → ${p}`);
    else { logError(`Not found: ${cmd}`); fail++; }
  }

  if (CF_API_TOKEN === 'YOUR_CLOUDFLARE_API_TOKEN_HERE' || !CF_API_TOKEN) {
    logError('CF_API_TOKEN not set — fill it in .env next to backup.js'); fail++;
  }
  if (CF_ACCOUNT_ID === 'YOUR_CLOUDFLARE_ACCOUNT_ID_HERE' || !CF_ACCOUNT_ID) {
    logError('CF_ACCOUNT_ID not set — fill it in .env next to backup.js'); fail++;
  }
  let writable = true;
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.accessSync(OUTPUT_DIR, fs.constants.W_OK);
  } catch { writable = false; }
  if (!writable) { logError(`Cannot write to OUTPUT_DIR: ${OUTPUT_DIR}`); fail++; }
  else logOk(`Output dir: ${OUTPUT_DIR}`);

  const tfv = run(TF_BINARY, ['version', '-json']);
  const tfVer = jqAlt(() => JSON.parse(tfv.stdout).terraform_version, '');
  if (tfVer) logInfo(`Terraform version: ${tfVer}`);
  const cftVer = run('cf-terraforming', ['version']).stdout.split('\n')[0];
  if (cftVer) logInfo(`cf-terraforming version: ${cftVer}`);
  // v0.30.0 matches provider v5.28.0+ (api_shield_discovery_operation emits
  // discovery_id; registrar_domain dropped). Older releases generate config
  // the current provider rejects.
  const cftNum = /v?(\d+)\.(\d+)\.(\d+)/.exec(cftVer);
  if (cftNum) {
    const [maj, min] = [Number(cftNum[1]), Number(cftNum[2])];
    if (maj === 0 && min < 30) {
      logWarn(`cf-terraforming ${cftNum[0].replace(/^v/, '')} is older than v0.30.0 — upgrade: https://github.com/cloudflare/cf-terraforming/releases`);
    }
  }

  // ── R2 upload prereqs ──────────────────────────────────────────────────────
  if (R2_SKIP_UPLOAD !== 'true') {
    if (!R2_ACCESS_KEY_ID) { logError('R2_ACCESS_KEY_ID not set'); fail++; }
    if (!R2_SECRET_ACCESS_KEY) { logError('R2_SECRET_ACCESS_KEY not set'); fail++; }
    if (!R2_BUCKET_NAME) { logError('R2_BUCKET_NAME not set'); fail++; }
    if (!R2_ENDPOINT) { logError('R2_ENDPOINT not set'); fail++; }
    // No rules file = restore the bucket's own rules after the upload (see r2RestoreLock).
    if (fs.existsSync(R2_LOCK_RULES_FILE)
      && !Array.isArray(jqAlt(() => JSON.parse(fs.readFileSync(R2_LOCK_RULES_FILE, 'utf8')).rules, null))) {
      logError(`R2_LOCK_RULES_FILE is not valid JSON with a top-level "rules" array: ${R2_LOCK_RULES_FILE}`);
      fail++;
    }
  } else {
    logWarn('R2_SKIP_UPLOAD=true — R2 upload disabled');
  }

  // ── AWS S3 upload prereqs ─────────────────────────────────────────────────
  if (AWS_SKIP_UPLOAD !== 'true') {
    if (!AWS_ACCESS_KEY_ID) { logError('AWS_ACCESS_KEY_ID not set'); fail++; }
    if (!AWS_SECRET_ACCESS_KEY) { logError('AWS_SECRET_ACCESS_KEY not set'); fail++; }
    if (!AWS_S3_BUCKET) { logError('AWS_S3_BUCKET not set'); fail++; }
  } else {
    logWarn('AWS_SKIP_UPLOAD=true — AWS S3 upload disabled');
  }

  // A run whose local folder is discarded afterwards must upload somewhere,
  // or it "succeeds" with nothing kept.
  if (REQUIRE_UPLOAD && R2_SKIP_UPLOAD === 'true' && AWS_SKIP_UPLOAD === 'true') {
    logError(`No upload destination configured, but this run requires one (${E.BACKUP_REQUIRE_UPLOAD
      ? 'BACKUP_REQUIRE_UPLOAD is set' : 'running on GitHub Actions, where the local backup is discarded'})`);
    logError('  Enable R2 or AWS S3 upload (R2_SKIP_UPLOAD=false / AWS_SKIP_UPLOAD=false), or set BACKUP_REQUIRE_UPLOAD=0');
    fail++;
  }

  // Bucket names, prefixes and regions end up in URLs (API paths, the S3 host name):
  // only accept their real formats so they cannot redirect requests elsewhere.
  const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
  const PREFIX_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{0,200}$/;
  const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
  if (R2_SKIP_UPLOAD !== 'true') {
    if (R2_BUCKET_NAME && !BUCKET_RE.test(R2_BUCKET_NAME)) { logError(`R2_BUCKET_NAME is not a valid bucket name: ${R2_BUCKET_NAME}`); fail++; }
    if (!PREFIX_RE.test(R2_PREFIX)) { logError(`R2_PREFIX contains invalid characters: ${R2_PREFIX}`); fail++; }
  }
  if (AWS_SKIP_UPLOAD !== 'true') {
    if (AWS_S3_BUCKET && !BUCKET_RE.test(AWS_S3_BUCKET)) { logError(`AWS_S3_BUCKET is not a valid bucket name: ${AWS_S3_BUCKET}`); fail++; }
    if (AWS_REGION && !REGION_RE.test(AWS_REGION)) { logError(`AWS_REGION is not a valid AWS region: ${AWS_REGION}`); fail++; }
  }

  if (fail > 0) { logError('Fix issues above then re-run.'); exitNow(1); }
  logOk('All prerequisites satisfied');
}

// =============================================================================
// CLOUDFLARE API HELPERS
// =============================================================================
// Every failing request is recorded as "<http_code>\t<path>\t<message>" so a
// reviewer can tell "nothing configured" from "couldn't read it". main()
// points this at <backup_root>/_api_errors.tsv; before that, errors are dropped.
let API_ERROR_LOG = null;
const apiErrors = [];
// Per-run scratch dir (provider schema, temp files); set in main().
let WORK_DIR = '';

function writeApiErrorLog() {
  if (API_ERROR_LOG) {
    fs.writeFileSync(API_ERROR_LOG, `http_code\tpath\tmessage\n${apiErrors.map((l) => `${l}\n`).join('')}`);
  }
}
// cfApiList probes page 1 quietly: it retries or accepts some 400s and logs
// the ones that turn out to be real failures itself.
let cfApiQuiet400 = false;
function recordApiError(code, p, msg) {
  if (!API_ERROR_LOG) return;
  apiErrors.push(`${code}\t${p}\t${msg}`);
  writeApiErrorLog();
}
// Undo the entry cfApi just recorded, for responses a caller has decided are
// not real failures (see cfApiList's page-1 retries).
function dropLastApiError() {
  if (API_ERROR_LOG && apiErrors.length) {
    apiErrors.pop();
    writeApiErrorLog();
  }
}

// Responses are parsed JSON; a 2xx body that isn't JSON comes back as this
// marker so callers treat it as an unexpected shape.
const NON_JSON = Symbol('non-json');

// cfApi(path, {method, body}) → parsed response. Retries 429/5xx with linear
// backoff. On failure the error is logged and recorded, and callers always get
// a {success:false,…} envelope even when the error body wasn't one. The token
// is sent in a request header only — never on a command line.
async function cfApi(p, { method = 'GET', body } = {}) {
  let attempt = 0;
  let status;
  let text;
  for (;;) {
    attempt++;
    try {
      const r = await fetch(`${CF_API_BASE}${p}`, {
        method,
        headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body,
      });
      status = r.status;
      text = await r.text();
    } catch {
      logWarn(`  [curl] Network error: ${p}`);
      recordApiError('000', p, 'network error');
      return { result: null, result_info: { total_pages: 1 }, success: false };
    }
    // Retry rate limits and transient server errors with linear backoff.
    if ((status === 429 || String(status).startsWith('5')) && attempt < 5) {
      logWarn(`  [API] HTTP ${status} on ${p} — retry ${attempt}/4`);
      await sleep(attempt * 5000);
      continue;
    }
    break;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }

  if (status === 200 || status === 201) {
    return parsed === undefined ? { [NON_JSON]: true, text } : parsed;
  }
  const msg = isObj(parsed) ? jqAlt(() => errMessage(parsed), 'unknown') : 'non-JSON response';
  if (status === 403) logWarn(`  [API] 403 Forbidden (token missing permission): ${p}`);
  else if (status === 404) logWarn(`  [API] 404 Not Found (plan-gated or missing): ${p}`);
  else if (!(cfApiQuiet400 && status === 400)) logWarn(`  [API] HTTP ${status} on ${p} — ${msg}`);
  recordApiError(status, p, msg);
  // Guarantee callers can detect the failure even when the error body isn't
  // the usual {"success":false,...} envelope.
  if (!(isObj(parsed) && hasOwn(parsed, 'success'))) {
    parsed = { success: false, result: null, errors: [{ code: Number(status) || 0, message: msg }] };
  }
  return parsed;
}

// Probe a GET without logging/recording failures — for existence checks where
// a 404 is the expected answer (e.g. per-hostname AOP lookups). Returns the
// parsed body on HTTP 200 only, otherwise null.
async function cfApiProbe(p) {
  try {
    const r = await fetch(`${CF_API_BASE}${p}`, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
    const text = await r.text();
    if (r.status !== 200) return null;
    return jqAlt(() => JSON.parse(text), null);
  } catch {
    return null;
  }
}

// Download a raw (non-JSON) API response to a file, e.g. Worker script
// content. On failure the body is kept as <out>.error instead.
async function cfApiDownload(p, outFile) {
  let status = 0;
  let buf = null;
  try {
    const r = await fetch(`${CF_API_BASE}${p}`, { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
    status = r.status;
    buf = Buffer.from(await r.arrayBuffer());
  } catch {
    status = 0;
  }
  const name = path.basename(outFile);
  if (status === 200) {
    fs.writeFileSync(outFile, buf);
    logOk(`    ${name}`);
  } else if (status === 204) {
    // No content to download, e.g. a static-assets-only Worker (has_assets,
    // no script modules) — nothing to save, not a failure.
    fs.rmSync(outFile, { force: true });
    logInfo(`    ${name}: no content (204)`);
  } else {
    fs.writeFileSync(`${outFile}.error`, buf !== null ? buf : 'network error\n');
    recordApiError(status === 0 ? '000' : status, p, 'download failed');
    logWarn(`    ${name}: NOT saved (HTTP ${status === 0 ? '000' : status})`);
  }
}

// saveJson(outFile, input, filter)
// Writes <outFile> ONLY if the request succeeded and the filter applies
// cleanly. Otherwise writes <outFile>.error describing why, so a failed read is
// never mistaken for "nothing configured". `input` is an API response, or an
// already-merged array from cfApiList* (null when the listing failed).
function saveJson(outFile, input, filter = identityFilter) {
  const name = path.basename(outFile);
  if (input === null || input === undefined) {
    fs.writeFileSync(`${outFile}.error`, 'request failed — see _api_errors.tsv in the backup root\n');
    logWarn(`  ${name}: NOT saved (API request failed)`);
    return;
  }
  if (isObj(input) && hasOwn(input, 'success') && input.success !== true) {
    fs.writeFileSync(`${outFile}.error`,
      `${JSON.stringify({ errors: input.errors ?? null, messages: input.messages ?? null }, null, 2)}\n`);
    logWarn(`  ${name}: NOT saved (${jqAlt(() => errMessage(input), 'API error')})`);
    return;
  }
  let value;
  try {
    if (isObj(input) && input[NON_JSON]) throw new Error('non-JSON');
    value = filter(input);
    if (value === undefined) throw new Error('no output');
  } catch {
    fs.rmSync(outFile, { force: true });
    fs.writeFileSync(`${outFile}.error`, `unexpected response shape (jq filter '${filter.jq || '.'}' failed)\n`);
    logWarn(`  ${name}: NOT saved (unexpected response shape)`);
    return;
  }
  fs.writeFileSync(outFile, `${JSON.stringify(value, null, 2)}\n`);
  logOk(`  ${name}${Array.isArray(value) ? `  (${value.length} items)` : ''}`);
}
// Filters carry their jq spelling for the .error message.
const jqFilter = (keys) => Object.assign((o) => jqGet(o, keys), { jq: `.${keys.join('.')}` });
const identityFilter = Object.assign((x) => x, { jq: '.' });
const fResult = jqFilter(['result']);

// Extracts one page's array from an API response. null if the request failed
// or the selected value isn't an array — e.g. R2's {"result":{"buckets":[...]}}
// needs keys ['result', 'buckets'].
function pageArray(resp, keys) {
  if (!isObj(resp) || resp[NON_JSON] || resp.success !== true) return null;
  const v = jqAlt(() => jqGet(resp, keys), []);
  return Array.isArray(v) ? v : null;
}

// cfApiList(path, keys) — page-number pagination (page/per_page). Returns the
// merged array, or null if any page fails — callers (saveJson) treat null as a
// failed read rather than "zero items". Uses result_info.total_pages, then
// total_count/per_page, then "short page means last page".
async function cfApiList(p, keys = ['result']) {
  const sep = p.includes('?') ? '&' : '?';
  // Known per_page caps, so the first request already fits (the step-down
  // below still covers any other endpoint): rulesets state "cannot be greater
  // than 50"; Pages projects (10) and deployments (25) reject larger values
  // with a bare 400 — no cap is stated in the error or the API docs.
  let perPage = 100;
  if (/\/rulesets$/.test(p)) perPage = 50;
  else if (/\/pages\/projects$/.test(p)) perPage = 10;
  else if (/\/pages\/projects\/.*\/deployments$/.test(p)) perPage = 25;
  let page = 1;
  let results = [];
  let prevPage = null;
  for (;;) {
    cfApiQuiet400 = page === 1;
    let resp;
    try {
      resp = await cfApi(`${p}${sep}per_page=${perPage}&page=${page}`);
    } finally {
      cfApiQuiet400 = false;
    }
    const pageResults = pageArray(resp, keys);
    if (pageResults === null) {
      // Page-1 errors that aren't real failures (the error cfApi recorded for
      // them is dropped again):
      //  - "per_page cannot be greater than N" (rulesets: 50) → retry with N
      //  - "Invalid list options … per_page" with no stated cap (Pages
      //    projects: 10) → step per_page down 100→50→25→10→5
      //  - "Page bigger than the number of pages" (registrar with zero
      //    domains reports total_pages=0) → genuinely empty
      const msg = jqRaw(jqAlt(() => errMessage(resp), ''));
      const capM = /per_page cannot be greater than ([0-9]+)/.exec(msg);
      const cap = capM ? Number(capM[1]) : null;
      if (page === 1) {
        if (cap !== null && cap < perPage) {
          logInfo(`  [API] ${p}: per_page capped at ${cap} — retrying`);
          dropLastApiError();
          perPage = cap;
          continue;
        }
        if ((msg.includes('list options') || msg.includes('per_page')) && perPage > 5) {
          perPage = { 100: 50, 50: 25, 25: 10 }[perPage] ?? 5;
          logInfo(`  [API] ${p}: per_page rejected — retrying with ${perPage}`);
          dropLastApiError();
          continue;
        }
        if (msg.includes('Page bigger than the number of pages')) {
          dropLastApiError();
          return [];
        }
      }
      logWarn(`  [API] listing ${p} failed on page ${page}${msg ? ` (${msg})` : ''} — partial result discarded`);
      return null;
    }
    // Endpoints that ignore paging params return the same full set every
    // time — stop rather than duplicating it.
    const pageJson = JSON.stringify(pageResults);
    if (page > 1 && pageJson === prevPage) break;
    prevPage = pageJson;
    results = results.concat(pageResults);
    const count = pageResults.length;
    // No result_info at all → unpaginated endpoint, this was everything.
    const ri = resp.result_info;
    if (ri === null || ri === undefined) break;
    let totalPages = null;
    if (isObj(ri) && ri.total_pages !== null && ri.total_pages !== undefined) {
      totalPages = ri.total_pages;
    } else if (isObj(ri) && ri.total_count !== null && ri.total_count !== undefined) {
      const pp = ri.per_page || perPage;
      totalPages = Math.floor((ri.total_count + pp - 1) / pp);
    }
    if (totalPages !== null) {
      if (page >= Number(totalPages)) break;
    } else {
      const pp = (isObj(ri) && ri.per_page) || perPage;
      if (count === 0 || count < pp) break;
    }
    page++;
    if (page > 5000) { logWarn(`  [API] ${p}: stopped after 5000 pages`); break; }
  }
  return results;
}

// cfApiListCursor(path, keys, perPage) — cursor pagination, used by endpoints
// that ignore page numbers: list items (result_info.cursors.after, per_page
// ≤ 500) and R2 buckets (result_info.cursor, per_page ≤ 1000). Same
// null-on-failure contract as cfApiList.
async function cfApiListCursor(p, keys = ['result'], perPage = 100) {
  const sep = p.includes('?') ? '&' : '?';
  let cursor = '';
  let results = [];
  let calls = 0;
  for (;;) {
    let q = `per_page=${perPage}`;
    if (cursor) q += `&cursor=${uriEncode(cursor)}`;
    const resp = await cfApi(`${p}${sep}${q}`);
    const pageResults = pageArray(resp, keys);
    if (pageResults === null) {
      logWarn(`  [API] listing ${p} failed after ${calls} page(s) — partial result discarded`);
      return null;
    }
    results = results.concat(pageResults);
    const count = pageResults.length;
    const nextV = jqAlt(() => jqGet(resp, ['result_info', 'cursors', 'after']), null)
      ?? jqAlt(() => jqGet(resp, ['result_info', 'cursor']), null);
    const next = nextV === null ? '' : jqRaw(nextV);
    calls++;
    if (!next || next === cursor || count === 0) break;
    cursor = next;
    if (calls > 10000) { logWarn(`  [API] ${p}: stopped after 10000 pages`); break; }
  }
  return results;
}

// =============================================================================
// ZONE DISCOVERY
// Returns every zone on the account as [zone_id, zone_name] pairs, applying
// ZONE_STATUS_FILTER, ZONE_STATUS_EXCLUDE and ZONE_NAME_FILTER — or, when zone
// IDs were given, exactly those zones.
// =============================================================================
async function discoverZones() {
  if (ZONE_IDS) return lookupExplicitZones();

  logSection(`Discovering zones on account ${CF_ACCOUNT_ID}`);
  const statusQs = ZONE_STATUS_FILTER !== 'all' ? `&status=${ZONE_STATUS_FILTER}` : '';
  const zones = await cfApiList(`/zones?account.id=${CF_ACCOUNT_ID}${statusQs}`);
  if (zones === null) {
    logError('Could not list zones (see API errors above) — check CF_API_TOKEN has Zone:Read');
    throw new Error('zone discovery failed');
  }
  logInfo(`  Found ${zones.length} zone(s) before name-filter/allow-list (status filter: ${ZONE_STATUS_FILTER})`);

  const exclude = ZONE_STATUS_EXCLUDE.split(' ').filter((s) => s.length > 0);
  const excluded = zones.filter((z) => exclude.includes(z.status)).map((z) => `${jqRaw(z.name)} (${jqRaw(z.status)})`);
  if (excluded.length) logInfo(`  Skipping by ZONE_STATUS_EXCLUDE='${ZONE_STATUS_EXCLUDE}': ${excluded.join(' ')}`);

  // Apply ZONE_NAME_FILTER (shell glob)
  const nameRe = globToRegex(ZONE_NAME_FILTER);
  const filtered = zones
    .filter((z) => !exclude.includes(z.status))
    .map((z) => [tsvVal(z.id), tsvVal(z.name)])
    .filter(([zid, zname]) => zid && nameRe.test(zname));
  logOk(`  ${filtered.length} zone(s) selected for backup (name filter: '${ZONE_NAME_FILTER}')`);

  if (filtered.length === 0) {
    logError('No zones matched — check ZONE_STATUS_FILTER / ZONE_NAME_FILTER');
    throw new Error('no zones matched');
  }
  return filtered;
}

// Explicit zone IDs (command line or ZONE_IDS): each one is looked up directly
// with GET /zones/{id}, so the status/name filters don't apply. A zone that
// belongs to a different account than CF_ACCOUNT_ID is refused.
async function lookupExplicitZones() {
  logSection('Looking up requested zone(s)');
  const res = [];
  let failed = 0;
  for (const zid of ZONE_IDS.split(' ').filter(Boolean)) {
    const resp = await cfApi(`/zones/${zid}`);
    const zname = resp.success === true ? jqAlt(() => jqGet(resp, ['result', 'name']), '') : '';
    const zacct = jqAlt(() => jqGet(resp, ['result', 'account', 'id']), '');
    if (!zname) {
      logError(`  ${zid}: zone not found or token cannot read it`);
      failed++;
    } else if (zacct !== CF_ACCOUNT_ID) {
      logError(`  ${zid} (${zname}) belongs to account ${zacct}, not CF_ACCOUNT_ID ${CF_ACCOUNT_ID}`);
      failed++;
    } else {
      logOk(`  ${zid} → ${zname}`);
      res.push([zid, zname]);
    }
  }
  if (failed > 0) {
    logError(`${failed} requested zone ID(s) could not be used — fix them and re-run`);
    throw new Error('zone lookup failed');
  }
  return res;
}

// =============================================================================
// TERRAFORM HELPERS
// =============================================================================
function writeProviderTf(dir) {
  fs.writeFileSync(path.join(dir, 'provider.tf'), `# Auto-generated by cf_backup.sh
terraform {
  required_version = ">= ${TF_MIN_VERSION}"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "${CF_PROVIDER_VERSION}"
    }
  }
}

provider "cloudflare" {
  # Auth via CLOUDFLARE_API_TOKEN env var (exported by cf_backup.sh)
}
`);
  logOk('  provider.tf written');
}

// Without a successful init cf-terraforming cannot read the provider schema
// and EVERY generate call in that directory fails — so a failed init aborts
// the run instead of producing a backup full of silently-missing resources.
function tfInit(dir) {
  logInfo('  terraform init …');
  const args = [`-chdir=${dir}`, 'init', '-input=false', '-upgrade', '-backend=false'];
  let r = run(TF_BINARY, args);
  if (r.status === 0) {
    logOk('  terraform init complete');
    return;
  }
  // The plugin cache isn't safe for concurrent use: another backup running the
  // cached provider makes init fail to rewrite it. Retry without the cache
  // (this directory downloads its own copy).
  if ((r.stdout + r.stderr).includes('text file busy')) {
    const env = { ...process.env };
    delete env.TF_PLUGIN_CACHE_DIR;
    r = run(TF_BINARY, args, { env });
    if (r.status === 0) {
      logOk('  terraform init complete (provider cache busy — downloaded a private copy)');
      return;
    }
  }
  logError(`  terraform init failed in ${dir}:`);
  emit(process.stderr, (r.stdout + r.stderr).trimEnd().split('\n').slice(-20).join('\n'));
  throw new Error(`terraform init failed in ${dir}`);
}

// Provider schema (terraform providers schema -json), dumped once per run
// into WORK_DIR. Used to filter API JSON down to the attributes the provider
// actually accepts before it is written as HCL.
let PROVIDER_SCHEMA_JSON = '';
let PROVIDER_SCHEMA = null;
function dumpProviderSchema(dir) {
  if (PROVIDER_SCHEMA_JSON && fs.existsSync(PROVIDER_SCHEMA_JSON) && fs.statSync(PROVIDER_SCHEMA_JSON).size > 0) return;
  PROVIDER_SCHEMA_JSON = path.join(WORK_DIR, 'provider_schema.json');
  const fd = fs.openSync(PROVIDER_SCHEMA_JSON, 'w');
  const r = spawnSync(TF_BINARY, [`-chdir=${dir}`, 'providers', 'schema', '-json'], { stdio: ['ignore', fd, 'ignore'] });
  fs.closeSync(fd);
  if (r.status !== 0) {
    logError(`  Could not dump provider schema from ${dir}`);
    throw new Error('provider schema dump failed');
  }
  PROVIDER_SCHEMA = null;
}
function providerSchema() {
  if (!PROVIDER_SCHEMA) PROVIDER_SCHEMA = JSON.parse(fs.readFileSync(PROVIDER_SCHEMA_JSON, 'utf8'));
  return PROVIDER_SCHEMA;
}

// generateResource(dir, type, scopeFlag, scopeId, extraFlags) → 'ok' | 'empty' | 'failed'
// Appends generated HCL to <dir>/<type>.tf. cf-terraforming's stderr is
// appended to <dir>/_generate_errors.log; it logs API errors (403 etc.) at
// INFO level and still exits 0 with empty output, so stderr — not the exit
// code — separates "none configured" from "couldn't read". The API token is
// taken from CLOUDFLARE_API_TOKEN in the environment (exported by main), never
// passed as a command-line argument.
const GEN_ERR_RE = /level=(error|fatal)|failed to fetch|Unsupported terraform|error getting API response|No resource IDs defined|unsupported resource type/;
// 404 / empty result / "product has not been enabled" (400, code 11001) /
// "File Upload Scan not enabled" / "not available for your plan type"
// (403, code 1135) all mean there is nothing to back up. cf-terraforming exits
// 1 on those too, so the exit code alone can't decide.
const GEN_BENIGN_RE = /404|[Nn]ot [Ff]ound|no result found|has not been enabled|[Nn]ot enabled|not available for your plan/;

function generateResource(dir, resourceType, scopeFlag, scopeId, extraFlags = []) {
  logInfo(`    → ${resourceType}`);

  // Output goes to a file, never into memory: some types return megabytes.
  const outFile = path.join(WORK_DIR, `gen_out.${crypto.randomBytes(4).toString('hex')}`);
  const errFile = path.join(WORK_DIR, `gen_err.${crypto.randomBytes(4).toString('hex')}`);
  let rc;
  let errText;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');
    const r = spawnSync('cf-terraforming', [
      'generate',
      '--resource-type', resourceType,
      '--terraform-binary-path', which(TF_BINARY) || TF_BINARY,
      '--terraform-install-path', dir,
      scopeFlag, scopeId,
      ...extraFlags,
    ], { stdio: ['ignore', outFd, errFd] });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    rc = r.status === null ? 1 : r.status;
    errText = fs.readFileSync(errFile, 'utf8');
    if (errText.length > 0) {
      fs.appendFileSync(path.join(dir, '_generate_errors.log'),
        `### ${isoZ()} ${resourceType} ${scopeFlag} ${scopeId} (exit ${rc})\n${errText}`);
    }
    // Transient: another run rewriting the shared provider cache ("failed to
    // read provider schema … not consistent with the lock file") or the API
    // rate limit. Anything else is final.
    if (rc !== 0 && attempt < 3 && /failed to read provider schema|429 Too Many Requests/.test(errText)) {
      logInfo(`      (${resourceType}: transient failure — retrying in ${attempt * 10}s)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 10000);
      continue;
    }
    break;
  }

  const errLinesAll = errText.split('\n');
  if (errLinesAll[errLinesAll.length - 1] === '') errLinesAll.pop();
  const allErr = errLinesAll.filter((l) => GEN_ERR_RE.test(l));
  const errLines = allErr.filter((l) => !GEN_BENIGN_RE.test(l));

  fs.rmSync(errFile, { force: true });

  if (allErr.length && !errLines.length) {
    logInfo(`      (${resourceType}: feature not enabled / not on this plan)`);
    fs.rmSync(outFile, { force: true });
    return 'empty';
  }

  if (rc !== 0 || errLines.length) {
    const reason = (errLines[0] || '').replace(/.*msg="?/, '').replace(/"$/, '').slice(0, 200);
    logWarn(`      generate FAILED for ${resourceType}: ${reason || `exit ${rc}`} (see _generate_errors.log)`);
    fs.appendFileSync(path.join(dir, '_generate_failures.txt'), `${resourceType}\t${reason || `exit ${rc}`}\n`);
    fs.rmSync(outFile, { force: true });
    return 'failed';
  }

  const hcl = fs.readFileSync(outFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  if (!/[^\s]/.test(hcl)) {
    logInfo(`      (no ${resourceType} resources found)`);
    return 'empty';
  }
  fs.appendFileSync(path.join(dir, `${resourceType}.tf`), `${hcl}\n`);
  logOk(`      HCL  → ${resourceType}.tf`);
  return 'ok';
}

// generateResourceIds(dir, type, scopeFlag, scopeId, ids)
// For resource types cf-terraforming refuses to generate without
// --resource-id. All IDs are tried in one call first; cf-terraforming abandons
// the WHOLE batch if any single ID 404s, so if the batch yields nothing the IDs
// are retried one at a time (capped at GEN_PER_ID_FALLBACK_MAX).
const GEN_PER_ID_FALLBACK_MAX = 150;
function generateResourceIds(dir, resourceType, scopeFlag, scopeId, ids) {
  if (ids.length === 0) {
    logInfo(`    → ${resourceType}: no IDs discovered — nothing to generate`);
    return;
  }
  const status = generateResource(dir, resourceType, scopeFlag, scopeId,
    ['--resource-id', `${resourceType}=${ids.join(',')}`]);
  if (status === 'ok' || ids.length === 1) return;

  if (ids.length > GEN_PER_ID_FALLBACK_MAX) {
    logWarn(`      ${resourceType}: batch of ${ids.length} IDs produced nothing; too many to retry individually`);
    return;
  }
  logInfo(`      retrying ${resourceType} one ID at a time (${ids.length} IDs) …`);
  let ok = 0;
  for (const id of ids) {
    if (generateResource(dir, resourceType, scopeFlag, scopeId, ['--resource-id', `${resourceType}=${id}`]) === 'ok') ok++;
  }
  logInfo(`      ${resourceType}: ${ok}/${ids.length} IDs generated individually`);
}

function setupTfDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  writeProviderTf(dir);
  tfInit(dir);
  dumpProviderSchema(dir);
}

// =============================================================================
// HCL HELPERS
// -----------------------------------------------------------------------
//   schemaFilter()  — drop every key the provider schema doesn't accept as
//                     configuration (computed-only / unknown API fields).
//                     Needed because `terraform validate` does NOT reject
//                     unknown keys inside nested object attributes.
//   toHcl()         — JSON → HCL with correct escaping: quotes, backslashes,
//                     control chars, and HCL template sequences (${ → $${,
//                     %{ → %%{) so WAF expressions like "${jndi:" stay
//                     literal; object keys quoted unless plain identifiers.
//   resourceBlocks() — locate top-level blocks in terraform-fmt'd HCL.
// =============================================================================
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function loadResourceSchema(resourceType) {
  for (const prov of Object.values(providerSchema().provider_schemas || {})) {
    const rs = (prov.resource_schemas || {})[resourceType];
    if (rs) return rs.block;
  }
  throw new Error(`${resourceType} not in provider schema`);
}
function loadAllSchemas() {
  const all = {};
  for (const prov of Object.values(providerSchema().provider_schemas || {})) {
    for (const [k, v] of Object.entries(prov.resource_schemas || {})) all[k] = v.block.attributes;
  }
  return all;
}
const configurable = (attr) => Boolean(attr.required || attr.optional);

function filterCtype(value, ctype) {
  // cty type expressions: "string" | ["list", T] | ["set", T] | ["map", T] | ["object", {k: T}] | "dynamic"
  if (Array.isArray(ctype) && ctype.length === 2) {
    const [kind, inner] = ctype;
    if ((kind === 'list' || kind === 'set') && Array.isArray(value)) return value.map((v) => filterCtype(v, inner));
    if (kind === 'map' && isObj(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, filterCtype(v, inner)]));
    }
    if (kind === 'object' && isObj(value)) {
      return Object.fromEntries(Object.entries(value)
        .filter(([k, v]) => hasOwn(inner, k) && v !== null)
        .map(([k, v]) => [k, filterCtype(v, inner[k])]));
    }
  }
  return value;
}

function filterAttr(value, attr) {
  if (value === null || value === undefined) return null;
  const nested = attr.nested_type;
  if (nested) {
    const mode = nested.nesting_mode || 'single';
    if ((mode === 'list' || mode === 'set') && Array.isArray(value)) {
      return value.filter(isObj).map((v) => schemaFilter(v, nested.attributes));
    }
    if (mode === 'map' && isObj(value)) {
      return Object.fromEntries(Object.entries(value).filter(([, v]) => isObj(v))
        .map(([k, v]) => [k, schemaFilter(v, nested.attributes)]));
    }
    if (isObj(value)) return schemaFilter(value, nested.attributes);
    return null;
  }
  if (hasOwn(attr, 'type')) return filterCtype(value, attr.type);
  return value;
}

// Keep only keys that are configurable (required/optional) in `attributes`.
function schemaFilter(obj, attributes) {
  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    const attr = hasOwn(attributes, k) ? attributes[k] : null;
    if (!attr || !configurable(attr) || v === null) continue;
    const fv = filterAttr(v, attr);
    if (fv === null) continue;
    res[k] = fv;
  }
  return res;
}

function hclString(s) {
  s = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  s = s.split('${').join('$${').split('%{').join('%%{');
  return `"${s}"`;
}
const hclKey = (k) => (IDENT_RE.test(k) ? k : hclString(k));

function toHcl(value, indent = 1) {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return hclString(value);
  if (value === null || value === undefined) return 'null';
  if (isObj(value)) {
    const items = Object.entries(value).filter(([, v]) => v !== null && v !== undefined);
    if (!items.length) return '{}';
    return `{\n${items.map(([k, v]) => `${inner}${hclKey(k)} = ${toHcl(v, indent + 1)}`).join('\n')}\n${pad}}`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((v) => `${inner}${toHcl(v, indent + 1)}`).join(',\n')}\n${pad}]`;
  }
  return 'null';
}

const BLOCK_START_RE = /^(resource|data|import|moved|removed)\b/;

// [start_idx, end_idx_inclusive] for top-level blocks in fmt'd HCL: a block
// opens on a column-0 keyword line and closes on a column-0 '}'.
function resourceBlocks(lines) {
  const blocks = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (BLOCK_START_RE.test(lines[i]) && lines[i].trimEnd().endsWith('{')) {
      let j = i + 1;
      while (j < n && lines[j].trimEnd() !== '}') j++;
      blocks.push([i, Math.min(j, n - 1)]);
      i = j + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

const leadingSpaces = (l) => l.length - l.replace(/^ +/, '').length;

// Remove every attribute (top-level or nested) the provider schema does not
// accept as configuration: read-only fields, which fail validate, and unknown
// API fields (created_at, uid, …), which pass validate but break plan/apply on
// restore. Works on terraform-fmt'd HCL by indentation. → [newText, removedPaths]
// API JSON key → provider attribute name: originRequest → origin_request,
// noTLSVerify → no_tls_verify, matchSNItoHost → match_sn_ito_host,
// warp-routing → warp_routing.
function snakeName(k) {
  return k.replace(/-/g, '_').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// API keys cf-terraforming copies verbatim (camelCase / hyphenated) are
// renamed to the schema's snake_case attribute when one exists. Keys of
// map-nested attributes (e.g. risk_behavior `behaviors`) are map keys, not
// attributes: they are kept and their values checked.
function stripNonConfigAttrs(text, schemas) {
  const lines = text.split('\n');
  const res = [];
  const removed = [];
  let i = 0;
  const n = lines.length;
  let rt = null;
  let stack = [];
  while (i < n) {
    let ln = lines[i];
    const m = /^resource "([^"]+)"/.exec(ln);
    if (m) {
      rt = m[1];
      stack = [[0, hasOwn(schemas, rt) ? schemas[rt] : null, rt, false]];
      res.push(ln); i++; continue;
    }
    if (rt === null || ln === '}') {
      if (ln === '}') rt = null;
      res.push(ln); i++; continue;
    }
    const hd = /<<-?([A-Za-z_]+)\s*$/.exec(ln);
    const ind = leadingSpaces(ln);
    while (stack.length > 1 && ind < stack[stack.length - 1][0]) stack.pop();
    const km = /^(\s*)("(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(ln);
    const [, attrs, cur, isMap] = stack[stack.length - 1];
    if (km && attrs !== null) {
      let key = km[2];
      if (key.startsWith('"')) key = jqAlt(() => JSON.parse(key), key);
      const rest = km[3].trimEnd();
      const opens = rest.endsWith('{') || rest.endsWith('[') || rest.endsWith('[{');
      let end = i;
      if (opens) {
        let j = i + 1;
        while (j < n) {
          const lj = lines[j];
          if (leadingSpaces(lj) === ind && '}]'.includes(lj.trimStart().slice(0, 1)) && !lj.trimEnd().endsWith('{')) break;
          j++;
        }
        end = j;
      } else if (hd) {
        let j = i + 1;
        while (j < n && lines[j].trim() !== hd[1]) j++;
        end = j;
      }
      if (isMap) {
        if (opens) {
          stack.push([ind + 2, attrs, `${cur}.${key}`, false]);
        } else if (hd) {
          res.push(...lines.slice(i, end + 1));
          i = end + 1;
          continue;
        }
        res.push(ln); i++; continue;
      }
      let a = hasOwn(attrs, key) ? attrs[key] : null;
      if (a === null) {
        const alt = snakeName(key);
        const b = hasOwn(attrs, alt) ? attrs[alt] : null;
        if (alt !== key && b !== null && configurable(b)) {
          a = b; key = alt;
          ln = `${km[1]}${alt} = ${km[3]}`;
        }
      }
      if (a === null || !configurable(a)) {
        removed.push(`${cur}.${key}`);
        i = end + 1;
        continue;
      }
      if (opens) {
        const nt = a.nested_type;
        stack.push([ind + 2, nt ? nt.attributes : null, `${cur}.${key}`, !!nt && nt.nesting_mode === 'map']);
      } else if (hd) {
        res.push(ln, ...lines.slice(i + 1, end + 1));
        i = end + 1;
        continue;
      }
    }
    res.push(ln); i++;
  }
  return [res.join('\n'), removed];
}

// [start, end] of `name = <value>` in a block body, where value is a
// bracketed/braced expression; string-aware so braces inside quoted
// expressions don't confuse the depth count. null if absent.
function findAttrSpan(body, name) {
  const m = new RegExp(`^\\s*${escRe(name)}\\s*=\\s*`, 'm').exec(body);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (i >= body.length || !'[{'.includes(body[i])) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  while (i < body.length) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return [m.index, i + 1];
    }
    i++;
  }
  return null;
}

// Split `key = [ {..}, {..} ]` into its top-level object texts (string-aware).
function splitListItems(spanText) {
  const items = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = null;
  for (let i = 0; i < spanText.length; i++) {
    const c = spanText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') {
      depth++;
      if (depth === 2 && c === '{') start = i;
    } else if (c === ']' || c === '}') {
      if (depth === 2 && c === '}' && start !== null) { items.push(spanText.slice(start, i + 1)); start = null; }
      depth--;
    }
  }
  return items;
}

function topAttr(obj, key) {
  const m = new RegExp(`^(\\s*)${key}\\s*=\\s*(.+)$`, 'm').exec(obj);
  return m ? m[2].trim() : null;
}

// Drop whole `resource "<type>" …` blocks matching `predicate(body)`.
function dropBlocksWhere(file, resourceType, predicate) {
  const text = fs.readFileSync(file, 'utf8');
  const pattern = new RegExp(`resource "${escRe(resourceType)}" "([^"]+)" \\{([\\s\\S]*?)\\n\\}\\n?`, 'g');
  const dropped = [];
  const newText = text.replace(pattern, (whole, label, body) => {
    if (predicate(body)) { dropped.push(label); return ''; }
    return whole;
  });
  fs.writeFileSync(file, newText);
  return dropped;
}
const pyList = (arr) => `[${arr.map((s) => `'${s}'`).join(', ')}]`;

// =============================================================================
// RULESET `rules` SAFETY NET + LIST ITEMS
// -----------------------------------------------------------------------
// injectRulesetRulesGap(dir, kind, apiPathPrefix, scopeId)
//   For every cloudflare_ruleset block of kind=<kind> that cf-terraforming
//   emitted WITHOUT a `rules` attribute, fetch the phase's live entrypoint
//   (GET /{zones|accounts}/{id}/rulesets/phases/{phase}/entrypoint) and write
//   its rules in, filtered against the provider schema. Blocks that already
//   carry rules are NOT touched.
// =============================================================================
async function injectRulesetRulesGap(dir, kind, apiPathPrefix, scopeId) {
  const tfPath = path.join(dir, 'cloudflare_ruleset.tf');
  if (!fs.existsSync(tfPath)) return;

  logInfo(`  Checking kind=${kind} rulesets for missing rules …`);
  let failures = 0;
  try {
    const ruleAttrs = loadResourceSchema('cloudflare_ruleset').attributes.rules.nested_type.attributes;
    let text = fs.readFileSync(tfPath, 'utf8');

    const blocks = [];
    for (const m of text.matchAll(/^resource\s+"cloudflare_ruleset"\s+"([^"]+)"\s*\{/gm)) {
      const mEnd = m.index + m[0].length;
      const span = findAttrSpan(`x = ${text.slice(mEnd - 1)}`, 'x');
      if (!span) continue;
      const bodyStart = mEnd;
      const bodyEnd = mEnd - 1 + span[1] - 4 - 1;
      const body = text.slice(bodyStart, bodyEnd);
      if (!new RegExp(`^\\s*kind\\s*=\\s*"${escRe(kind)}"`, 'm').test(body)) continue;
      const phaseM = /^\s*phase\s*=\s*"([^"]*)"/m.exec(body);
      if (phaseM) blocks.push({ label: m[1], phase: phaseM[1], bodyStart, bodyEnd, body });
    }
    const missing = blocks.filter((b) => findAttrSpan(b.body, 'rules') === null);
    out(`  ${blocks.length} kind=${kind} ruleset(s); ${missing.length} without rules`);

    const edits = [];
    const failed = []; // [label, reason]: rules could not be read → block quarantined, never kept rule-less
    for (const b of missing) {
      const url = `https://api.cloudflare.com/client/v4/${apiPathPrefix}/${scopeId}/rulesets/phases/${b.phase}/entrypoint`;
      let resp;
      try {
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${E.CLOUDFLARE_API_TOKEN}` },
          signal: AbortSignal.timeout(60000),
        });
        if (r.status >= 400) {
          if (r.status === 404) out(`    phase=${b.phase}: no live entrypoint (404) — nothing to add`);
          else { out(`    phase=${b.phase}: ERROR HTTP ${r.status} — rules not readable`); failed.push([b.label, `rules could not be read (HTTP ${r.status})`]); failures++; }
          continue;
        }
        resp = JSON.parse(await r.text());
      } catch (e) {
        out(`    phase=${b.phase}: ERROR network (${e.message}) — rules not readable`);
        failed.push([b.label, `rules could not be read (${e.message})`]);
        failures++;
        continue;
      }
      const rules = jqIter((resp.result || {}).rules || []).map((rule) => schemaFilter(rule, ruleAttrs));
      if (!rules.length) {
        out(`    phase=${b.phase}: live ruleset has 0 rules`);
        continue;
      }
      edits.push([b.bodyStart, b.bodyEnd, `${b.body.trimEnd()}\n  rules = ${toHcl(rules, 1)}\n`]);
      out(`    phase=${b.phase}: added ${rules.length} live rule(s)`);
    }
    for (const [s, e, nb] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, s) + nb + text.slice(e);
    if (edits.length) fs.writeFileSync(tfPath, text);
    // A ruleset kept without its rules would, when restored, delete every live rule of that
    // phase. Quarantine it (→ .broken, listed in the backup manifest) so it is never restored.
    if (failed.length) {
      const lines = fs.readFileSync(tfPath, 'utf8').split('\n');
      const errs = failed.map(([label, why]) => [lines.findIndex((l) => l.startsWith(`resource "cloudflare_ruleset" "${label}"`)) + 1, `NOT BACKED UP: ${why}`]).filter(([ln]) => ln > 0);
      if (errs.length && quarantineBlocks(tfPath, errs) === null) {
        fs.appendFileSync(`${tfPath}.broken`, `# NOT BACKED UP: rules could not be read\n${fs.readFileSync(tfPath, 'utf8')}`);
        fs.rmSync(tfPath, { force: true });
      }
      logWarn(`  ${failed.length} ruleset(s) quarantined — their rules could not be read, so they are not in this backup`);
    }
  } catch (e) {
    out(`  ${e.message}`);
    failures++;
  }
  if (failures) logWarn(`  Some kind=${kind} rulesets could not be completed (see messages above)`);
  else logOk(`  cloudflare_ruleset.tf: kind=${kind} rules complete`);
}

// writeListItems(listsDir, index)
//   Writes every list entry as a cloudflare_list_item resource in
//   <listsDir>/cloudflare_list_item.tf, with list_id referencing its
//   cloudflare_list block. Entries come from the cursor-paginated JSON dumps
//   (complete), not cf-terraforming (which stops at the first page). Separate
//   resources rather than the list's inline `items` set: the provider
//   validates that set quadratically — a 9k-entry list took >3 min inline vs
//   ~8 s as resources. index maps {"<list_id>": "<path to items json>"}.
function writeListItems(dir, index) {
  const listTf = path.join(dir, 'cloudflare_list.tf');
  if (!fs.existsSync(listTf)) return;
  let failed = false;
  try {
    const itemAttrs = loadResourceSchema('cloudflare_list_item').attributes;
    const text = fs.readFileSync(listTf, 'utf8');

    const blocks = [];
    const missing = [];
    let done = 0;
    let total = 0;
    for (const m of text.matchAll(/^resource\s+"cloudflare_list"\s+"([^"]+)"\s*\{/gm)) {
      const label = m[1];
      const mEnd = m.index + m[0].length;
      const endIdx = text.indexOf('\n}', mEnd);
      if (endIdx < 0) throw new Error('substring not found');
      const body = text.slice(mEnd, endIdx);
      const listId = Object.keys(index).find((lid) => label.includes(lid) || body.includes(`"${lid}"`)) ?? null;
      if (listId === null) { missing.push(label); continue; }
      const acctM = /^\s*account_id\s*=\s*"([^"]+)"/m.exec(body);
      if (!acctM) throw new Error(`no account_id in ${label}`);
      const acct = acctM[1];
      JSON.parse(fs.readFileSync(index[listId], 'utf8')).forEach((it, n) => {
        const attrs = schemaFilter(it, itemAttrs);
        delete attrs.account_id;
        delete attrs.list_id;
        const itemLabel = `terraform_managed_resource_${it.id || `${listId}_${n}`}`;
        const lines = [`resource "cloudflare_list_item" "${itemLabel}" {`,
          `  account_id = ${toHcl(acct)}`,
          `  list_id    = cloudflare_list.${label}.id`];
        for (const [k, v] of Object.entries(attrs)) lines.push(`  ${hclKey(k)} = ${toHcl(v, 1)}`);
        blocks.push(`${lines.join('\n')}\n}`);
        total++;
      });
      done++;
    }

    // The list blocks themselves must not also carry an inline `items` set.
    let newText = text;
    let stripped = 0;
    const heads = [...newText.matchAll(/^resource\s+"cloudflare_list"\s+"[^"]+"\s*\{/gm)].reverse();
    for (const m of heads) {
      const mEnd = m.index + m[0].length;
      const end = newText.indexOf('\n}', mEnd);
      const body = newText.slice(mEnd, end);
      const span = findAttrSpan(body, 'items');
      if (span) {
        newText = newText.slice(0, mEnd) + body.slice(0, span[0]) + body.slice(span[1]) + newText.slice(end);
        stripped++;
      }
    }
    if (stripped) fs.writeFileSync(listTf, newText);

    if (blocks.length) fs.writeFileSync(path.join(dir, 'cloudflare_list_item.tf'), `${blocks.join('\n\n')}\n`);
    out(`  cloudflare_list_item: ${total} item(s) across ${done} list(s)`);
    if (missing.length) {
      out(`  cloudflare_list: could not match list id for: ${pyList(missing)}`);
      failed = true;
    }
  } catch (e) {
    out(`  ${e.message}`);
    failed = true;
  }
  if (failed) logWarn('  Some cloudflare_list blocks could not be matched to their items');
  else logOk('  cloudflare_list_item.tf written');
}

// =============================================================================
// PATCH KNOWN CF-TERRAFORMING GENERATOR GAPS
// Applied to every zone directory immediately after the generate calls,
// before validateAndPrune so that errors never reach terraform.
// =============================================================================
async function patchGeneratedTf(dir, zoneId) {
  logSection(`  Patching known cf-terraforming generator gaps in ${path.basename(dir)}`);

  // ── 1. cloudflare_certificate_pack: drop type="universal" ─────────────────
  // Universal certs are auto-provisioned per zone and cannot be managed or
  // created via this resource (provider v5 only allows type="advanced").
  const certPath = path.join(dir, 'cloudflare_certificate_pack.tf');
  if (fs.existsSync(certPath)) {
    const dropped = dropBlocksWhere(certPath, 'cloudflare_certificate_pack', (b) => /type\s*=\s*"universal"/.test(b));
    out(dropped.length
      ? `  certificate_pack: dropped ${dropped.length} universal resource(s): ${pyList(dropped)}`
      : '  certificate_pack: nothing to patch');
    logOk('  Patched cloudflare_certificate_pack.tf (dropped type=universal)');
  }

  // ── 2. cloudflare_custom_pages: add missing identifier ────────────────────
  // cf-terraforming never emits the required `identifier` attribute; derive it
  // from the resource label by stripping the generated prefix/suffix.
  const pagesPath = path.join(dir, 'cloudflare_custom_pages.tf');
  if (fs.existsSync(pagesPath)) {
    const text = fs.readFileSync(pagesPath, 'utf8');
    let n = 0;
    const newText = text.replace(/resource "cloudflare_custom_pages" "([^"]+)" \{([\s\S]*?)\n\}/g, (whole, label, body) => {
      n++;
      if (/\bidentifier\s*=/.test(body)) return whole;
      const slug = label.replace(/^terraform_managed_resource_/, '').replace(/_\d+$/, '');
      return `resource "cloudflare_custom_pages" "${label}" {\n  identifier = "${slug}"${body}\n}`;
    });
    fs.writeFileSync(pagesPath, newText);
    out(`  custom_pages: added identifier to ${n} resource(s)`);
    logOk('  Patched cloudflare_custom_pages.tf (added identifier)');
  }

  // ── 3. cloudflare_bot_management: strip cf_robots_variant ─────────────────
  // Provider v5 bug: cf_robots_variant is written as "off" but the API returns
  // null after write → "provider produced inconsistent result" on every apply.
  const botPath = path.join(dir, 'cloudflare_bot_management.tf');
  if (fs.existsSync(botPath)) {
    const lines = fs.readFileSync(botPath, 'utf8').split('\n');
    fs.writeFileSync(botPath, lines.filter((l) => !/^\s*cf_robots_variant\s*=/.test(l)).join('\n'));
    logOk('  Patched cloudflare_bot_management.tf (removed cf_robots_variant)');
  }

  // ── 4. cloudflare_zone_hold: drop if no active hold ───────────────────────
  // If the zone has no active hold (hold = true absent), Cloudflare returns 404
  // on PATCH — there is nothing to restore. Drop the resource.
  const holdPath = path.join(dir, 'cloudflare_zone_hold.tf');
  if (fs.existsSync(holdPath)) {
    const dropped = dropBlocksWhere(holdPath, 'cloudflare_zone_hold', (b) => !/\bhold\s*=\s*true\b/.test(b));
    out(dropped.length
      ? `  zone_hold: dropped ${dropped.length} inactive hold resource(s): ${pyList(dropped)}`
      : '  zone_hold: active hold present — keeping resource');
    logOk('  Patched cloudflare_zone_hold.tf (dropped inactive holds)');
  }

  // ── 5. cloudflare_ruleset: fill in rules only where cf-terraforming emitted
  //      a block without them (safety net, see injectRulesetRulesGap)
  await injectRulesetRulesGap(dir, 'zone', 'zones', zoneId);

  // ── 6. API→schema mismatches shared with the account dir ────────────────
  patchSchemaGaps(dir);

  // ── 7. cloudflare_api_shield: drop unconfigured API Shield ──────────────
  // GET /zones/{id}/api_gateway/configuration answers even when API Shield was
  // never set up, and cf-terraforming then emits a block without the required
  // auth_id_characteristics, which fails validate. Nothing to restore.
  const shieldPath = path.join(dir, 'cloudflare_api_shield.tf');
  if (fs.existsSync(shieldPath)) {
    const dropped = dropBlocksWhere(shieldPath, 'cloudflare_api_shield', (b) => !/\bauth_id_characteristics\s*=/.test(b));
    out(dropped.length ? `  api_shield: dropped ${dropped.length} unconfigured block(s)` : '  api_shield: configured — keeping');
    if (!fs.readFileSync(shieldPath, 'utf8').replace(/\s/g, '')) fs.rmSync(shieldPath, { force: true });
  }

  // ── 8. cloudflare_snippet_rules: reference the snippets ─────────────────
  // Rules name their snippet as a plain string, so on a fresh restore
  // Terraform could create the rules before the snippets exist (the API
  // rejects rules for unknown snippets). Pointing snippet_name at the
  // cloudflare_snippet resource makes Terraform create the snippets first.
  const rulesPath = path.join(dir, 'cloudflare_snippet_rules.tf');
  const snipPath = path.join(dir, 'cloudflare_snippet.tf');
  if (fs.existsSync(rulesPath) && fs.existsSync(snipPath)) {
    const labels = new Map();
    for (const m of fs.readFileSync(snipPath, 'utf8').matchAll(/resource "cloudflare_snippet" "([^"]+)" \{([\s\S]*?)\n\}/g)) {
      const name = /^ {2}snippet_name\s*=\s*"([^"]+)"/m.exec(m[2]);
      if (name) labels.set(name[1], m[1]);
    }
    let count = 0;
    const text = fs.readFileSync(rulesPath, 'utf8').replace(/^(\s+snippet_name\s*=\s*)"([^"]+)"[ \t]*$/gm, (whole, pre, name) => {
      if (!labels.has(name)) return whole;
      count++;
      return `${pre}cloudflare_snippet.${labels.get(name)}.snippet_name`;
    });
    fs.writeFileSync(rulesPath, text);
    out(`  snippet_rules: ${count} rule(s) now reference their cloudflare_snippet`);
    logOk('  Patched cloudflare_snippet_rules.tf (snippet_name → cloudflare_snippet references)');
  }

  logOk('  Patch pass complete');
}

// Quarantines only the resource BLOCKS terraform reports errors in (moved to
// <file>.broken, appended), not whole files — one bad DNS record must not take
// every other record in cloudflare_dns_record.tf with it. Falls back to
// quarantining the whole file when an error can't be tied to a block. Only
// severity=error diagnostics count; warnings never cause pruning.
//
// NOTE: a passing validate is necessary, not sufficient — terraform does not
// reject unknown keys inside nested object attributes, so HCL this script
// writes itself is schema-filtered at write time (see schemaFilter).
// errs: [[line, message], …] — validate errors in this file.
function quarantineBlocks(file, errs) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const blocks = resourceBlocks(lines);
  const bad = [];
  const why = new Map();
  let unmatched = false;
  const sorted = [...errs].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [ln, msg] of sorted) {
    const hit = blocks.find(([s, e]) => s <= ln - 1 && ln - 1 <= e);
    if (!hit) { unmatched = true; continue; }
    if (!bad.includes(hit)) { bad.push(hit); why.set(hit, []); }
    if (msg && !why.get(hit).includes(msg)) why.get(hit).push(msg);
  }
  if (unmatched || !bad.length) return null; // caller quarantines the whole file
  const cut = new Set();
  const drop = [];
  for (const blk of bad) {
    const [s, e] = blk;
    // Each quarantined block is preceded by the validate error(s) it caused.
    drop.push(why.get(blk).map((m) => `# terraform validate: ${m}\n`).join('') + lines.slice(s, e + 1).join('\n'));
    for (let k = s; k <= e; k++) cut.add(k);
    const head = /^resource "([^"]+)" "([^"]+)"/.exec(lines[s]);
    const label = head ? `${head[1]}.${head[2]}` : `line ${s + 1}`;
    for (const m of why.get(blk)) emit(process.stderr, `      ↳ ${label}: ${m.slice(0, 200)}`);
  }
  const keep = lines.filter((l, k) => !cut.has(k));
  fs.appendFileSync(`${file}.broken`, `${drop.join('\n\n')}\n\n`);
  if (resourceBlocks(keep).length) fs.writeFileSync(file, keep.join('\n'));
  else fs.rmSync(file, { force: true });
  return bad.length;
}

function validateAndPrune(dir) {
  run(TF_BINARY, ['fmt'], { cwd: dir });
  const validate = () => run(TF_BINARY, ['validate', '-json'], { cwd: dir });

  if (validate().status === 0) {
    logOk('  terraform validate passed');
    return;
  }
  logWarn('  terraform validate failed — quarantining invalid resource blocks …');

  let prunedBlocks = 0;
  let prunedFiles = 0;
  for (let iterations = 1; iterations <= 10; iterations++) {
    const v = jqAlt(() => JSON.parse(validate().stdout), null);
    if (v && v.valid === true) break;

    // "<file>\t<line>\t<message>" for every error diagnostic outside provider.tf
    const locs = [...new Set(jqIter(v && v.diagnostics)
      .filter((d) => d.severity === 'error' && d.range && d.range.filename !== null && d.range.filename !== undefined)
      .map((d) => `${d.range.filename}\t${d.range.start.line}\t${`${d.summary ?? ''}: ${d.detail ?? ''}`.replace(/\s+/g, ' ').slice(0, 300)}`))]
      .sort()
      .filter((l) => !l.startsWith('provider.tf\t'));

    if (!locs.length) {
      logWarn('  terraform validate failing with no file-attributable errors — stopping');
      for (const d of jqIter(v && v.diagnostics).filter((x) => x.severity === 'error')) {
        emit(process.stderr, `    ${d.summary}: ${d.detail ?? ''}`);
      }
      break;
    }

    for (const badFile of [...new Set(locs.map((l) => l.split('\t')[0]))].sort()) {
      const full = path.join(dir, badFile);
      if (!badFile || !fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
      const rows = locs.filter((l) => l.split('\t')[0] === badFile).map((l) => l.split('\t'));
      const result = quarantineBlocks(full, rows.map((r) => [Number(r[1]), r.slice(2).join('\t')]));
      if (result !== null) {
        logWarn(`    quarantined ${result} invalid block(s) from ${badFile} → ${badFile}.broken`);
        prunedBlocks += result;
      } else {
        logWarn(`    quarantined whole file (error not tied to a block): ${badFile}`);
        const reasons = [...new Set(rows.map((r) => `# terraform validate: ${r.slice(2).join('\t')}`))].sort();
        fs.appendFileSync(`${full}.broken`, reasons.map((r) => `${r}\n`).join(''));
        fs.appendFileSync(`${full}.broken`, fs.readFileSync(full));
        fs.rmSync(full, { force: true });
        prunedFiles++;
      }
    }
  }

  if (validate().status === 0) {
    logOk(`  terraform validate passed after quarantining ${prunedBlocks} block(s), ${prunedFiles} file(s)`);
  } else {
    logWarn('  terraform validate still failing after pruning');
  }
  if (prunedBlocks > 0 || prunedFiles > 0) logWarn(`  Review ${dir}/*.broken for quarantined config`);
}

// patchSchemaGaps(dir)
// Fixes API→HCL mismatches cf-terraforming leaves behind that would otherwise
// fail validate (and get quarantined). Applied to zone AND account dirs.
//   zero_trust_access_service_token  client_secret_version without
//       previous_client_secret_expires_at is rejected — drop it (it's a
//       rotation counter, not config).
//   zero_trust_organization  service_token_inactivity emitted with
//       action/inactivity_threshold_days = null (feature off) — drop the block.
//   zero_trust_access_identity_provider  One-time PIN IdPs have name "" in the
//       API and cf-terraforming omits the required attribute — write it;
//       their scim_config is rejected by the provider — drop it.
//   zone_dnssec  transitional API states (pending / pending-disabled) aren't
//       valid config — map to the state being transitioned to.
//   zero_trust_access_application  reusable policies are referenced as
//       {id, precedence}; self_hosted_domains dropped when destinations is
//       set; session_duration / app_launcher_visible dropped for app types
//       that don't allow them.
//   ai_gateway  required `id` (gateway slug) restored from the label.
//   workers_deployment  annotations keys "workers/message" / "workers/
//       triggered_by" renamed to the schema's workers_message (the computed
//       workers_triggered_by is dropped) — otherwise every import plans as a
//       replace.
//   zero_trust_dlp_predefined_profile  the deprecated `entries` list is
//       converted to v5's `enabled_entries` (IDs of the enabled entries).
//   zero_trust_device_custom_profile  the account default profile (no name)
//       is dropped — it's already captured by device_default_profile.
//   magic_wan_gre/ipsec_tunnel  empty shells (account_id only) dropped.
//   bot_management  bot_preference_sync_enabled is dropped — Cloudflare accepts
//       it but never returns it, so the provider fails every apply of it.
//   managed_transforms  disabled headers are dropped — the provider reads only
//       enabled ones back, and disabled is the same as not listed.
//   email_routing_rule  the catch-all rule (matcher "all") is dropped — it is
//       already exported as cloudflare_email_routing_catch_all.
//   device_default_profile_local_domain_fallback  emitted as one resource per
//       domain; merged back into the single per-account list.
// Then, for every resource type: stripNonConfigAttrs() removes any attribute —
// at any depth — that the schema marks read-only or doesn't know.
function editBlocks(file, resourceType, fn) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const res = [];
  let last = 0;
  let changed = 0;
  for (const [s, e] of resourceBlocks(lines)) {
    if (!lines[s].startsWith(`resource "${resourceType}"`)) continue;
    const block = lines.slice(s, e + 1).join('\n');
    const nb = fn(block);
    if (nb !== block) changed++;
    res.push(...lines.slice(last, s));
    if (nb) res.push(...nb.split('\n'));
    last = e + 1;
  }
  res.push(...lines.slice(last));
  if (changed) fs.writeFileSync(file, res.join('\n'));
  return changed;
}

const removeSpan = (b, span) => b.slice(0, span[0]).replace(/ +$/, '') + b.slice(span[1]).replace(/^\n+/, '');

const TYPES_SESSION = new Set(['saas', 'dash_sso', 'self_hosted', 'ssh', 'vnc', 'rdp', 'infrastructure',
  'app_launcher', 'warp', 'mcp_portal', 'mcp', 'proxy_endpoint']);
const TYPES_LAUNCHER = new Set(['self_hosted', 'ssh', 'vnc', 'rdp', 'saas', 'bookmark']);

const SCHEMA_GAP_FIXES = {
  cloudflare_zero_trust_access_service_token: (b) => (b.includes('previous_client_secret_expires_at')
    ? b : b.replace(/^\s*client_secret_version\s*=.*\n/gm, '')),

  cloudflare_zero_trust_organization: (b) => {
    const span = findAttrSpan(b, 'service_token_inactivity');
    return span && /\baction\s*=\s*null/.test(b.slice(span[0], span[1])) ? removeSpan(b, span) : b;
  },

  cloudflare_zero_trust_access_identity_provider: (b) => {
    if (!/^\s*name\s*=/m.test(b)) b = b.replace(/\{\n/, () => '{\n  name = ""\n');
    // The provider rejects scim_config on one-time-PIN IdPs, though the API
    // returns a (disabled) one.
    if (/^\s*type\s*=\s*"onetimepin"/m.test(b)) {
      const span = findAttrSpan(b, 'scim_config');
      if (span) b = removeSpan(b, span);
    }
    return b;
  },

  cloudflare_zone_dnssec: (b) => b.replace(/(status\s*=\s*)"pending-disabled"/g, '$1"disabled"')
    .replace(/(status\s*=\s*)"pending"/g, '$1"active"'),

  cloudflare_zero_trust_access_application: (b) => {
    // Reusable policies must be referenced as {id, precedence}; the API
    // returns the full policy body, which the provider rejects alongside id.
    const span = findAttrSpan(b, 'policies');
    if (span) {
      const newItems = splitListItems(b.slice(span[0], span[1])).map((it) => {
        if (/^\s*reusable\s*=\s*true/m.test(it)) {
          const pid = topAttr(it, 'id');
          const prec = topAttr(it, 'precedence');
          return `{\n${[`id = ${pid}`, ...(prec ? [`precedence = ${prec}`] : [])].join('\n')}\n}`;
        }
        // Inline (app-scoped) policy: defined by include/exclude/…; the
        // provider rejects its API id alongside include. Drop the id at the
        // item's own level only (nested group ids stay).
        const inds = it.split('\n').slice(1).filter((l) => /^\s*[a-z_]+\s*=/.test(l)).map(leadingSpaces);
        if (inds.length) {
          const keyInd = Math.min(...inds);
          return it.replace(new RegExp(`^${' '.repeat(keyInd)}id\\s*=.*\\n`, 'gm'), '');
        }
        return it;
      });
      b = `${b.slice(0, span[0])}  policies = [${newItems.join(', ')}]${b.slice(span[1])}`;
    }
    // self_hosted_domains is the deprecated form of destinations; not both.
    if (findAttrSpan(b, 'destinations')) b = b.replace(/^ {2}self_hosted_domains\s*=.*\n/gm, '');
    const t = /^ {2}type\s*=\s*"([^"]+)"/m.exec(b);
    if (t && !TYPES_SESSION.has(t[1])) b = b.replace(/^ {2}session_duration\s*=.*\n/gm, '');
    if (t && !TYPES_LAUNCHER.has(t[1])) b = b.replace(/^ {2}app_launcher_visible\s*=.*\n/gm, '');
    return b;
  },

  // `id` (the gateway slug) is required config; cf-terraforming omits it. It is
  // the label minus cf-terraforming's prefix/index suffix.
  cloudflare_ai_gateway: (b) => {
    if (!/^ {2}id\s*=/m.test(b)) {
      const lab = /^resource "[^"]+" "terraform_managed_resource_(.+)_\d+"/.exec(b);
      if (lab) b = b.replace(/\{\n/, () => `{\n  id = "${lab[1]}"\n`);
    }
    return b;
  },

  // Annotation keys come out as the API's "workers/message" /
  // "workers/triggered_by"; the schema's are workers_message and the computed
  // workers_triggered_by. Unknown keys pass validate but leave the message
  // unset, and every deployment attribute forces replacement — so each import
  // would plan as destroy + re-create.
  cloudflare_workers_deployment: (b) => b.replace(/"workers\/message"(\s*=)/g, 'workers_message$1')
    .replace(/^ +"workers\/triggered_by"\s*=.*\n/gm, ''),

  // v5 deprecates `entries` in favour of `enabled_entries`: the IDs of the
  // profile's entries to enable (any entry not listed is disabled).
  cloudflare_zero_trust_dlp_predefined_profile: (b) => {
    const lines = b.split('\n');
    const isEnd = (l) => l === '  }]' || l === '    }, {';
    for (let i = 0; i < lines.length; i++) {
      if (/^ {2}entries\s*=\s*\[\]\s*$/.test(lines[i])) {
        lines[i] = '  enabled_entries = []';
        return lines.join('\n');
      }
      if (!/^ {2}entries\s*=\s*\[\{\s*$/.test(lines[i])) continue;
      const ids = [];
      let cur = {};
      let j = i + 1;
      while (j < lines.length && !isEnd(lines[j])) {
        const m = /^ {4}(enabled|id)\s*=\s*(.+?)\s*$/.exec(lines[j]);
        if (m) cur[m[1]] = m[2];
        j++;
        if (j < lines.length && isEnd(lines[j])) {
          if (cur.enabled === 'true' && cur.id) ids.push(cur.id);
          cur = {};
          if (lines[j] === '    }, {') j++;
        }
      }
      if (j >= lines.length) return b;
      lines.splice(i, j - i + 1, ...(ids.length ? ['  enabled_entries = [', ...ids.map((v) => `    ${v},`), '  ]'] : ['  enabled_entries = []']));
      return lines.join('\n');
    }
    return b;
  },

  // The account's DEFAULT device profile (name null) comes back from the
  // custom-profiles list too; it's already in device_default_profile.
  cloudflare_zero_trust_device_custom_profile: (b) => (/^ {2}name\s*=/m.test(b) ? b : ''),

  // The zone's catch-all (matcher type "all") is listed by the rules API too;
  // it already lives in cloudflare_email_routing_catch_all, and a second copy
  // as a regular rule would be rejected on restore.
  cloudflare_email_routing_rule: (b) => (/matchers\s*=\s*\[\{\s*type\s*=\s*"all"\s*\}\]/.test(b) ? '' : b),

  // Cloudflare accepts bot_preference_sync_enabled but never returns it: the provider fails every
  // apply of it ("inconsistent result after apply") and every check shows it changed.
  cloudflare_bot_management: (b) => b.replace(/^\s*bot_preference_sync_enabled\s*=.*\n/gm, ''),

  // Disabled managed headers: the provider reads only the enabled ones back, so a disabled entry
  // looks like a change on every compare. Disabled = not listed, so they are dropped.
  cloudflare_managed_transforms: (b) => b.replace(/^( {2}managed_(?:request|response)_headers\s*=\s*)\[\{\n([\s\S]*?)\n {2}\}\]/gm, (all, head, body) => {
    const items = body.split(/\n {4}\}, \{\n/).map((x) => x.split('\n').map((l) => l.trim()).filter(Boolean));
    const kept = items.filter((it) => !it.some((l) => /^enabled\s*=\s*false$/.test(l)));
    if (kept.length === items.length) return all;
    return kept.length ? `${head}[{\n${kept.map((it) => it.map((l) => `    ${l}`).join('\n')).join('\n    }, {\n')}\n  }]` : `${head}[]`;
  }),

  // Empty shells emitted when the account has no tunnels.
  cloudflare_magic_wan_gre_tunnel: (b) => (onlyAccountId(b) ? '' : b),
  cloudflare_magic_wan_ipsec_tunnel: (b) => (onlyAccountId(b) ? '' : b),
};
function onlyAccountId(b) {
  const keys = [...b.matchAll(/^ {2}([a-z_]+)\s*=/gm)].map((m) => m[1]);
  return keys.length === 1 && keys[0] === 'account_id';
}

function patchSchemaGaps(dir) {
  // cf-terraforming emits the default profile's local-domain-fallback list as
  // one resource PER DOMAIN, but the resource is a single list per account —
  // restoring them separately would leave only the last domain. Merge them.
  const ldf = path.join(dir, 'cloudflare_zero_trust_device_default_profile_local_domain_fallback.tf');
  if (fs.existsSync(ldf)) {
    const lines = fs.readFileSync(ldf, 'utf8').split('\n');
    const perAcct = new Map();
    const blocks = resourceBlocks(lines);
    for (const [s, e] of blocks) {
      const blk = lines.slice(s, e + 1).join('\n');
      const acct = /account_id\s*=\s*"([^"]+)"/.exec(blk)[1];
      const span = findAttrSpan(blk, 'domains');
      const items = span ? splitListItems(blk.slice(span[0], span[1])) : [];
      if (!perAcct.has(acct)) perAcct.set(acct, []);
      perAcct.get(acct).push(...items);
    }
    if (blocks.length > perAcct.size) {
      const merged = [...perAcct].map(([acct, items]) =>
        `resource "cloudflare_zero_trust_device_default_profile_local_domain_fallback" `
        + `"terraform_managed_resource_${acct}_0" {\n  account_id = "${acct}"\n`
        + `  domains = [${items.join(', ')}]\n}`);
      fs.writeFileSync(ldf, `${merged.join('\n\n')}\n`);
      const nDomains = [...perAcct.values()].reduce((a, v) => a + v.length, 0);
      out(`  local_domain_fallback: merged into ${perAcct.size} resource(s), ${nDomains} domain(s)`);
    }
  }

  for (const [rtype, fn] of Object.entries(SCHEMA_GAP_FIXES)) {
    const file = path.join(dir, `${rtype}.tf`);
    if (!fs.existsSync(file)) continue;
    const n = editBlocks(file, rtype, fn);
    if (n) {
      out(`  ${rtype}: patched ${n} block(s)`);
      if (!/^resource /m.test(fs.readFileSync(file, 'utf8'))) fs.rmSync(file, { force: true }); // every block dropped
    }
  }

  // The generic pass below walks nesting by indentation, so normalise the
  // layout of anything rewritten above first.
  run(TF_BINARY, ['fmt', dir]);

  // Generic pass: strip non-configurable attributes everywhere (after the
  // fixes above, which need e.g. `reusable` before it is stripped).
  const schemas = loadAllSchemas();
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.tf')).sort()) {
    if (name === 'provider.tf') continue;
    const file = path.join(dir, name);
    const [nt, removed] = stripNonConfigAttrs(fs.readFileSync(file, 'utf8'), schemas);
    if (removed.length) {
      fs.writeFileSync(file, nt);
      const keys = [...new Set(removed.map((r) => r.slice(r.indexOf('.') + 1)))].sort();
      out(`  ${name}: stripped ${removed.length} read-only/unknown attribute(s): ${keys.join(', ').slice(0, 200)}`);
    }
  }
}

// Parse a multipart/form-data body into [{filename, content}] (the Snippets
// content API returns one part per file).
function parseMultipart(buf, contentType) {
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!/^multipart\//i.test(contentType || '') || !bm) return [];
  const boundary = (bm[1] || bm[2]).trim();
  const segs = buf.toString('latin1').split(`--${boundary}`);
  const parts = [];
  for (let i = 1; i < segs.length; i++) {
    let seg = segs[i];
    if (seg.startsWith('--')) break;
    seg = seg.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    let sep = seg.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (sep < 0) { sep = seg.indexOf('\n\n'); sepLen = 2; }
    const head = sep < 0 ? seg : seg.slice(0, sep);
    const body = sep < 0 ? '' : seg.slice(sep + sepLen);
    const headers = {};
    for (const line of head.split(/\r?\n/)) {
      const k = line.indexOf(':');
      if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
    }
    const cd = headers['content-disposition'] || '';
    const fn = /filename="([^"]*)"/i.exec(cd) || /filename=([^;]+)/i.exec(cd);
    const nm = /\bname="([^"]*)"/i.exec(cd) || /\bname=([^;]+)/i.exec(cd);
    let bytes = Buffer.from(body, 'latin1');
    const cte = (headers['content-transfer-encoding'] || '').toLowerCase();
    if (cte === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    else if (cte === 'quoted-printable') {
      bytes = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g,
        (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    }
    parts.push({ name: fn ? fn[1].trim() : (nm ? nm[1].trim() : null), content: bytes.toString('utf8') });
  }
  return parts;
}

// writeSnippets(dir, zoneId, rawDir)
// cf-terraforming has no mapping for cloudflare_snippet and its
// cloudflare_snippets output lacks the code, so snippets are built here:
// GET /zones/{id}/snippets lists them; GET .../snippets/{name}/content returns
// multipart/form-data (one part per file) with the entry point in the
// `cf-entrypoint` response header. Raw files are also saved under <rawDir>.
async function writeSnippets(dir, zoneId, rawDir) {
  logInfo('    → cloudflare_snippet (from the Snippets API)');
  const listResp = await cfApi(`/zones/${zoneId}/snippets`);
  const names = listResp.success === true
    ? jqIter(listResp.result).map((s) => jqRaw(isObj(s) ? (s.snippet_name ?? null) : null)).filter(Boolean)
    : [];
  if (!names.length) {
    logInfo('      (no snippets)');
    return;
  }
  fs.mkdirSync(rawDir, { recursive: true });
  const fetched = [];
  for (const name of names) {
    const bodyPath = path.join(rawDir, `${name}.multipart`);
    let status = 0;
    let buf = null;
    let ctype = '';
    let entry = '';
    try {
      const r = await fetch(`${CF_API_BASE}/zones/${zoneId}/snippets/${name}/content`,
        { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } });
      status = r.status;
      buf = Buffer.from(await r.arrayBuffer());
      ctype = r.headers.get('content-type') || '';
      entry = r.headers.get('cf-entrypoint') || '';
    } catch { status = 0; }
    if (status !== 200) {
      const code = status === 0 ? '000' : status;
      recordApiError(code, `/zones/${zoneId}/snippets/${name}/content`, 'snippet content');
      if (buf !== null) fs.writeFileSync(`${bodyPath}.error`, buf);
      logWarn(`      snippet ${name}: content NOT fetched (HTTP ${code})`);
      continue;
    }
    fs.writeFileSync(bodyPath, buf);
    fetched.push({ name, bodyPath, ctype, entry });
  }

  const blocks = [];
  for (const { name, bodyPath, ctype, entry } of fetched) {
    const files = parseMultipart(fs.readFileSync(bodyPath), ctype)
      .map((p) => ({ name: p.name, content: p.content }));
    for (const f of files) {
      const fdir = path.join(rawDir, name);
      fs.mkdirSync(fdir, { recursive: true });
      fs.writeFileSync(path.join(fdir, path.basename(f.name)), f.content);
    }
    if (!files.length) {
      out(`  snippet ${name}: no files in response — skipped`);
      continue;
    }
    fs.rmSync(bodyPath, { force: true }); // unpacked into rawDir/<name>/
    const main = entry || files[0].name;
    blocks.push([
      `resource "cloudflare_snippet" "terraform_managed_resource_${zoneId}_${name}" {`,
      `  zone_id      = ${toHcl(zoneId)}`,
      `  snippet_name = ${toHcl(name)}`,
      `  metadata     = ${toHcl({ main_module: main }, 1)}`,
      `  files        = ${toHcl(files, 1)}`,
      '}'].join('\n'));
  }
  if (blocks.length) fs.writeFileSync(path.join(dir, 'cloudflare_snippet.tf'), `${blocks.join('\n\n')}\n`);
  out(`  cloudflare_snippet: wrote ${blocks.length} snippet(s)`);
  logOk('      HCL  → cloudflare_snippet.tf');
}

// writeZoneResource(dir, zoneId)
// Writes this zone's cloudflare_zone block from GET /zones/{id}, keeping only
// attributes the provider schema accepts. Same label format cf-terraforming
// uses, so imports/restores line up with the other generated resources.
async function writeZoneResource(dir, zoneId) {
  logInfo(`    → cloudflare_zone (from GET /zones/${zoneId})`);
  const resp = await cfApi(`/zones/${zoneId}`);
  if (resp.success !== true) {
    logWarn('      cloudflare_zone NOT written (zone lookup failed)');
    return;
  }
  const attrs = schemaFilter(resp.result, loadResourceSchema('cloudflare_zone').attributes);
  const lines = [`resource "cloudflare_zone" "terraform_managed_resource_${zoneId}_0" {`,
    ...Object.entries(attrs).map(([k, v]) => `  ${hclKey(k)} = ${toHcl(v, 1)}`),
    '}'];
  fs.writeFileSync(path.join(dir, 'cloudflare_zone.tf'), `${lines.join('\n')}\n`);
  logOk('      HCL  → cloudflare_zone.tf');
}

// writeZoneAccessRules(dir, zoneId)
// Zone IP Access Rules as cloudflare_access_rule. GET /zones/{id}/firewall/
// access_rules/rules also returns account- and user-level rules that apply to
// the zone; only scope.type "zone" ones belong to the zone (cf-terraforming
// would write all of them with zone_id, so it is not used for this type).
async function writeZoneAccessRules(dir, zoneId) {
  logInfo('    → cloudflare_access_rule (zone IP Access rules, from the API)');
  const resp = await cfApi(`/zones/${zoneId}/firewall/access_rules/rules?per_page=1`);
  if (resp.success !== true) {
    logWarn('      cloudflare_access_rule NOT written (could not list IP Access rules)');
    fs.appendFileSync(path.join(dir, '_generate_failures.txt'), `cloudflare_access_rule\t${jqAlt(() => errMessage(resp), 'list failed')}\n`);
    return;
  }
  const rules = jqIter(await cfApiList(`/zones/${zoneId}/firewall/access_rules/rules`))
    .filter((r) => isObj(r) && isObj(r.scope) && r.scope.type === 'zone' && r.id);
  if (!rules.length) { logInfo('      (no zone-level IP Access rules)'); return; }
  const schema = loadResourceSchema('cloudflare_access_rule').attributes;
  const blocks = rules.map((r, i) => {
    const attrs = schemaFilter({ mode: r.mode, configuration: r.configuration, notes: r.notes || undefined }, schema);
    return [`resource "cloudflare_access_rule" "terraform_managed_resource_${r.id}_${i}" {`,
      ...Object.entries(attrs).map(([k, v]) => `  ${hclKey(k)} = ${toHcl(v, 1)}`),
      `  zone_id = ${toHcl(zoneId, 1)}`,
      '}'].join('\n');
  });
  fs.writeFileSync(path.join(dir, 'cloudflare_access_rule.tf'), `${blocks.join('\n\n')}\n`);
  logOk(`      HCL  → cloudflare_access_rule.tf (${rules.length} zone rule(s))`);
}

// writeUniversalSsl(dir, zoneId)
// cloudflare_universal_ssl_setting from GET /zones/{id}/ssl/universal/settings
// (cf-terraforming does not support this type).
async function writeUniversalSsl(dir, zoneId) {
  logInfo('    → cloudflare_universal_ssl_setting (from the API)');
  const resp = await cfApi(`/zones/${zoneId}/ssl/universal/settings`);
  // Not jqAlt: it treats `false` (Universal SSL disabled) as missing.
  const enabled = isObj(resp) && isObj(resp.result) ? resp.result.enabled : null;
  if (resp.success !== true || typeof enabled !== 'boolean') {
    logWarn('      cloudflare_universal_ssl_setting NOT written (lookup failed)');
    fs.appendFileSync(path.join(dir, '_generate_failures.txt'), `cloudflare_universal_ssl_setting\t${jqAlt(() => errMessage(resp), 'lookup failed')}\n`);
    return;
  }
  fs.writeFileSync(path.join(dir, 'cloudflare_universal_ssl_setting.tf'),
    `resource "cloudflare_universal_ssl_setting" "terraform_managed_resource_${zoneId}_0" {\n  enabled = ${enabled}\n  zone_id = ${toHcl(zoneId, 1)}\n}\n`);
  logOk('      HCL  → cloudflare_universal_ssl_setting.tf');
}

// writeBackupManifest(dir, zoneName)
// _backup_manifest.tf: comment-only (valid, empty Terraform), so it is uploaded
// with the .tf files. Lists what this zone backup could NOT capture, so a
// restore can say so instead of treating "missing" as "never existed".
// Lines starting "# ! " are warnings the restore shows.
function writeBackupManifest(dir, zoneName) {
  const warn = [];
  const failures = path.join(dir, '_generate_failures.txt');
  if (fs.existsSync(failures)) {
    for (const line of fs.readFileSync(failures, 'utf8').split('\n').filter(Boolean)) {
      const [type, ...why] = line.split('\t');
      warn.push(`not backed up: ${type} — ${why.join(' ').slice(0, 160) || 'export failed'}`);
    }
  }
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tf.broken')).sort()) {
    const labels = [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`);
    warn.push(labels.length ? `quarantined (invalid, not backed up): ${labels.join(', ')}` : `quarantined (invalid, not backed up): ${f.replace(/\.broken$/, '')}`);
  }
  const lines = [
    '# Backup manifest — written by backup.js. Comments only: Terraform ignores this file.',
    `# zone: ${zoneName}`,
    `# taken: ${isoZ()}`,
    '# Never restorable from Terraform files: custom (uploaded) SSL certificates and',
    '# Origin CA certificates (private keys cannot be read back), Workers script code,',
    '# and account-level objects zone config may reference (lists, LB pools, Access policies).',
    ...warn.map((w) => `# ! ${w.replace(/[\r\n]+/g, ' ')}`),
  ];
  fs.writeFileSync(path.join(dir, '_backup_manifest.tf'), `${lines.join('\n')}\n`);
  if (warn.length) logWarn(`  ${warn.length} item(s) could not be backed up for ${zoneName} — listed in _backup_manifest.tf`);
}

// =============================================================================
// ZONE-LEVEL TERRAFORM
// =============================================================================
// Zone-capable resources from the cf-terraforming README v5 "Generate" table
// that need no --resource-id, plus a few the provider supports and
// cf-terraforming maps but the README doesn't list.
//
// Deliberately NOT generated:
//   cloudflare_filter / cloudflare_firewall_rule / cloudflare_rate_limit —
//     sunset APIs; their replacements live in cloudflare_ruleset.
//   cloudflare_zero_trust_access_policy / cloudflare_mtls_certificate —
//     account-scoped only; generated in backupAccountTerraform().
//   cloudflare_origin_ca_certificate — cf-terraforming calls GET /certificates
//     without the required zone_id and always fails; dumped as JSON in
//     backupApiZone() instead. Private keys are never retrievable.
//   cloudflare_zone — cf-terraforming ignores --zone for this type and lists
//     EVERY zone the token can see, across all accounts. Written by
//     writeZoneResource() from GET /zones/{id} instead.
//   cloudflare_snippets — deprecated; cf-terraforming emits it without the
//     snippet code. Written as cloudflare_snippet by writeSnippets().
//   cloudflare_spectrum_application — Spectrum is not backed up or restored.
//   cloudflare_email_routing_dns — only lists the MX/TXT records Email Routing
//     needs; the provider reads it back empty and cannot apply it on the apex.
//     Email Routing on/off is kept in api_backup/…/email_routing_settings.json.
const ZONE_RESOURCES = [
  'cloudflare_api_shield',
  'cloudflare_api_shield_discovery_operation',
  'cloudflare_api_shield_operation',
  'cloudflare_api_shield_schema',
  'cloudflare_api_shield_schema_validation_settings',
  'cloudflare_argo_smart_routing',
  'cloudflare_argo_tiered_caching',
  'cloudflare_authenticated_origin_pulls_certificate',
  'cloudflare_authenticated_origin_pulls_settings',
  'cloudflare_bot_management',
  'cloudflare_certificate_pack',
  'cloudflare_content_scanning_expression',
  'cloudflare_custom_hostname',
  'cloudflare_custom_hostname_fallback_origin',
  'cloudflare_custom_pages',
  'cloudflare_dns_record',
  'cloudflare_dns_zone_transfers_incoming',
  'cloudflare_dns_zone_transfers_outgoing',
  'cloudflare_email_routing_catch_all',
  'cloudflare_email_routing_rule',
  'cloudflare_email_routing_settings',
  'cloudflare_healthcheck',
  'cloudflare_keyless_certificate',
  'cloudflare_leaked_credential_check',
  'cloudflare_leaked_credential_check_rule',
  'cloudflare_load_balancer',
  'cloudflare_logpull_retention',
  'cloudflare_logpush_job',
  'cloudflare_managed_transforms',
  'cloudflare_page_rule',
  'cloudflare_page_shield_policy',
  'cloudflare_regional_hostname',
  'cloudflare_regional_tiered_cache',
  'cloudflare_ruleset',
  'cloudflare_snippet_rules',
  'cloudflare_tiered_cache',
  'cloudflare_total_tls',
  'cloudflare_url_normalization_settings',
  'cloudflare_waiting_room',
  'cloudflare_waiting_room_settings',
  'cloudflare_web3_hostname',
  'cloudflare_workers_route',
  'cloudflare_zero_trust_access_application',
  'cloudflare_zero_trust_access_group',
  'cloudflare_zero_trust_access_identity_provider',
  'cloudflare_zero_trust_access_mtls_certificate',
  'cloudflare_zero_trust_access_mtls_hostname_settings',
  'cloudflare_zero_trust_access_service_token',
  'cloudflare_zero_trust_access_short_lived_certificate',
  'cloudflare_zero_trust_device_default_profile_certificates',
  'cloudflare_zero_trust_organization',
  'cloudflare_zone_cache_reserve',
  'cloudflare_zone_cache_variants',
  'cloudflare_zone_dns_settings',
  'cloudflare_zone_dnssec',
  'cloudflare_zone_hold',
  'cloudflare_zone_lockdown',
];

const safeName = (s, re) => s.replace(re, '_');
const sortUnique = (arr) => [...new Set(arr)].sort();

async function backupZoneTerraform(backupRoot, zoneName, zoneId) {
  const zoneSafe = safeName(zoneName, /[^a-zA-Z0-9._-]/g);
  const dir = path.join(backupRoot, zoneSafe);
  setupTfDir(dir);

  logSection(`Zone Terraform: ${zoneName}  (${zoneId})`);

  for (const resource of ZONE_RESOURCES) generateResource(dir, resource, '--zone', zoneId);
  await writeZoneResource(dir, zoneId);
  await writeZoneAccessRules(dir, zoneId);
  await writeUniversalSsl(dir, zoneId);
  await writeSnippets(dir, zoneId, path.join(backupRoot, 'account', 'api_backup', `zone_${zoneSafe}`, 'snippets'));

  // ── Resources that need --resource-id (IDs discovered via the API) ──────
  // Zone settings: every editable setting the zone reports.
  const settings = await cfApi(`/zones/${zoneId}/settings`);
  let ids = sortUnique(jqIter(jqAlt(() => jqGet(settings, ['result']), null))
    .filter((s) => isObj(s) && s.editable !== false).map((s) => jqRaw(s.id ?? null)));
  generateResourceIds(dir, 'cloudflare_zone_setting', '--zone', zoneId, ids);

  generateResourceIds(dir, 'cloudflare_hostname_tls_setting', '--zone', zoneId, ['ciphers', 'min_tls_version', 'http2']);

  // Waiting room events + rules are keyed by waiting room ID.
  ids = jqIter(await cfApiList(`/zones/${zoneId}/waiting_rooms`)).map((w) => jqRaw(isObj(w) ? (w.id ?? null) : null));
  generateResourceIds(dir, 'cloudflare_waiting_room_event', '--zone', zoneId, ids);
  generateResourceIds(dir, 'cloudflare_waiting_room_rules', '--zone', zoneId, ids);

  // Per-hostname Authenticated Origin Pulls is keyed by hostname, and the API
  // has no "list associations" endpoint. Associations require an uploaded
  // hostname certificate, so only when the zone has one are its proxied DNS
  // names probed (GET .../origin_tls_client_auth/hostnames/{hostname}).
  ids = [];
  const certs = await cfApiProbe(`/zones/${zoneId}/origin_tls_client_auth/hostnames/certificates`);
  const aopCerts = certs === null ? 0 : jqAlt(() => jqLength(jqGet(certs, ['result'])), 0);
  if (aopCerts > 0) {
    logInfo(`    per-hostname AOP: ${aopCerts} hostname cert(s) — probing proxied hostnames …`);
    const hosts = sortUnique(jqIter(await cfApiList(`/zones/${zoneId}/dns_records?proxied=true`))
      .map((r) => jqRaw(isObj(r) ? (r.name ?? null) : null)));
    for (const host of hosts) {
      if (!host) continue;
      const hp = await cfApiProbe(`/zones/${zoneId}/origin_tls_client_auth/hostnames/${host}`);
      const certId = hp === null ? null : jqAlt(() => jqGet(hp, ['result', 'cert_id']), null);
      if (certId !== null) ids.push(host);
    }
  }
  generateResourceIds(dir, 'cloudflare_authenticated_origin_pulls', '--zone', zoneId, ids);

  // Observatory scheduled speed tests are keyed by URL.
  const pages = await cfApi(`/zones/${zoneId}/speed_api/pages`);
  ids = jqIter(jqAlt(() => jqGet(pages, ['result']), null))
    .filter((pg) => isObj(pg) && pg.scheduleFrequency !== null && pg.scheduleFrequency !== undefined)
    .map((pg) => jqRaw(pg.url ?? null));
  generateResourceIds(dir, 'cloudflare_observatory_scheduled_test', '--zone', zoneId, ids);

  // Per-operation schema validation overrides, only when API Shield has
  // operations at all.
  ids = jqIter(await cfApiList(`/zones/${zoneId}/api_gateway/operations`))
    .map((o) => jqRaw(isObj(o) ? (o.operation_id ?? null) : null));
  generateResourceIds(dir, 'cloudflare_api_shield_operation_schema_validation_settings', '--zone', zoneId, ids);

  await patchGeneratedTf(dir, zoneId);
  validateAndPrune(dir);
  if (IMPORT_MODE) await writeImports(dir, { accountId: CF_ACCOUNT_ID, zoneId });
  writeBackupManifest(dir, zoneName);
  logOk(`Zone Terraform backup → ${dir}`);
}

// =============================================================================
// ACCOUNT-LEVEL TERRAFORM  (run once per backup, not once per zone)
// -----------------------------------------------------------------------
// Resource list and scope from the cf-terraforming README v5 "Generate" table,
// every name checked against the provider v5 schema.
//
// Deliberately NOT generated here:
//   cloudflare_list            — generated in backupLists() with its items.
//   cloudflare_waiting_room    — "account or zone"; already generated per zone.
//   cloudflare_snippets / cloudflare_snippet_rules — zone-scoped.
//   cloudflare_api_shield      — zone-scoped.
//   cloudflare_registrar_domain — not in the provider v5 schema; registrar data
//     is dumped as JSON in backupApiAccount() instead.
//   cloudflare_workers_script  — no cf-terraforming mapping; script content +
//     settings are downloaded via the API in backupApiAccount() instead.
// =============================================================================
const ACCOUNT_RESOURCES = [
  'cloudflare_account',
  'cloudflare_account_member',
  'cloudflare_account_subscription',
  'cloudflare_address_map',
  'cloudflare_ai_gateway',
  'cloudflare_ai_search_instance',
  'cloudflare_ai_search_namespace',
  'cloudflare_ai_search_token',
  'cloudflare_calls_sfu_app',
  'cloudflare_calls_turn_app',
  'cloudflare_d1_database',
  'cloudflare_dns_firewall',
  'cloudflare_dns_zone_transfers_acl',
  'cloudflare_dns_zone_transfers_peer',
  'cloudflare_dns_zone_transfers_tsig',
  'cloudflare_email_routing_address',
  'cloudflare_email_security_block_sender',
  'cloudflare_email_security_impersonation_registry',
  'cloudflare_email_security_trusted_domains',
  'cloudflare_hyperdrive_config',
  'cloudflare_load_balancer_monitor',
  'cloudflare_load_balancer_pool',
  'cloudflare_logpush_job',
  'cloudflare_magic_wan_gre_tunnel',
  'cloudflare_magic_wan_ipsec_tunnel',
  'cloudflare_magic_wan_static_route',
  'cloudflare_mtls_certificate',
  'cloudflare_notification_policy',
  'cloudflare_notification_policy_webhooks',
  'cloudflare_pages_project',
  'cloudflare_queue',
  'cloudflare_r2_bucket',
  'cloudflare_ruleset',
  'cloudflare_stream',
  'cloudflare_stream_key',
  'cloudflare_stream_live_input',
  'cloudflare_stream_watermark',
  'cloudflare_stream_webhook',
  'cloudflare_turnstile_widget',
  'cloudflare_user',
  'cloudflare_web_analytics_site',
  'cloudflare_workers_custom_domain',
  'cloudflare_workers_for_platforms_dispatch_namespace',
  'cloudflare_workers_kv_namespace',
  'cloudflare_zero_trust_access_application',
  'cloudflare_zero_trust_access_custom_page',
  'cloudflare_zero_trust_access_group',
  'cloudflare_zero_trust_access_identity_provider',
  'cloudflare_zero_trust_access_infrastructure_target',
  'cloudflare_zero_trust_access_key_configuration',
  'cloudflare_zero_trust_access_mtls_certificate',
  'cloudflare_zero_trust_access_mtls_hostname_settings',
  'cloudflare_zero_trust_access_policy',
  'cloudflare_zero_trust_access_service_token',
  'cloudflare_zero_trust_access_short_lived_certificate',
  'cloudflare_zero_trust_access_tag',
  'cloudflare_zero_trust_device_custom_profile',
  'cloudflare_zero_trust_device_default_profile',
  'cloudflare_zero_trust_device_default_profile_local_domain_fallback',
  'cloudflare_zero_trust_device_managed_networks',
  'cloudflare_zero_trust_device_posture_integration',
  'cloudflare_zero_trust_device_posture_rule',
  'cloudflare_zero_trust_dex_test',
  'cloudflare_zero_trust_dlp_dataset',
  'cloudflare_zero_trust_dns_location',
  'cloudflare_zero_trust_gateway_certificate',
  'cloudflare_zero_trust_gateway_logging',
  'cloudflare_zero_trust_gateway_policy',
  'cloudflare_zero_trust_gateway_proxy_endpoint',
  'cloudflare_zero_trust_gateway_settings',
  'cloudflare_zero_trust_list',
  'cloudflare_zero_trust_organization',
  'cloudflare_zero_trust_risk_behavior',
  'cloudflare_zero_trust_risk_scoring_integration',
  'cloudflare_zero_trust_tunnel_cloudflared',
  'cloudflare_zero_trust_tunnel_cloudflared_route',
  'cloudflare_zero_trust_tunnel_cloudflared_virtual_network',
];

async function backupAccountTerraform(backupRoot) {
  const dir = path.join(backupRoot, 'account');
  setupTfDir(dir);

  logSection(`Account Terraform  (${CF_ACCOUNT_ID})`);

  for (const resource of ACCOUNT_RESOURCES) generateResource(dir, resource, '--account', CF_ACCOUNT_ID);

  // ── Resources that need --resource-id (IDs discovered via the API) ──────
  const idsOf = (arr, key) => jqIter(arr).map((x) => jqRaw(isObj(x) ? (x[key] ?? null) : null));
  const A = CF_ACCOUNT_ID;

  // Worker script names → cron triggers, deployments, workers.dev subdomain.
  let ids = idsOf(await cfApiList(`/accounts/${A}/workers/scripts`), 'id');
  generateResourceIds(dir, 'cloudflare_workers_cron_trigger', '--account', A, ids);
  generateResourceIds(dir, 'cloudflare_workers_deployment', '--account', A, ids);
  generateResourceIds(dir, 'cloudflare_workers_script_subdomain', '--account', A, ids);

  // Tunnel ingress config only exists for remotely-managed tunnels
  // (remote_config=true); locally-configured ones 404.
  ids = jqIter(await cfApiList(`/accounts/${A}/cfd_tunnel?is_deleted=false`))
    .filter((t) => isObj(t) && t.remote_config === true).map((t) => jqRaw(t.id ?? null));
  generateResourceIds(dir, 'cloudflare_zero_trust_tunnel_cloudflared_config', '--account', A, ids);

  ids = idsOf(await cfApiList(`/accounts/${A}/queues`), 'queue_id');
  generateResourceIds(dir, 'cloudflare_queue_consumer', '--account', A, ids);

  ids = idsOf(await cfApiListCursor(`/accounts/${A}/r2/buckets`, ['result', 'buckets'], 1000), 'name');
  generateResourceIds(dir, 'cloudflare_r2_custom_domain', '--account', A, ids);
  generateResourceIds(dir, 'cloudflare_r2_managed_domain', '--account', A, ids);

  ids = idsOf(await cfApiList(`/accounts/${A}/pages/projects`), 'name');
  generateResourceIds(dir, 'cloudflare_pages_domain', '--account', A, ids);

  ids = jqIter(await cfApiList(`/accounts/${A}/rum/site_info/list`))
    .map((s) => jqAlt(() => jqGet(s, ['ruleset', 'id']), null)).filter((v) => v !== null).map(jqRaw);
  generateResourceIds(dir, 'cloudflare_web_analytics_rule', '--account', A, ids);

  const dlp = await cfApi(`/accounts/${A}/dlp/profiles`);
  const dlpProfiles = jqIter(jqAlt(() => jqGet(dlp, ['result']), null)).filter(isObj);
  ids = dlpProfiles.filter((p) => p.type === 'custom').map((p) => jqRaw(p.id ?? null));
  generateResourceIds(dir, 'cloudflare_zero_trust_dlp_custom_profile', '--account', A, ids);
  ids = dlpProfiles.filter((p) => p.type === 'predefined').map((p) => jqRaw(p.id ?? null));
  generateResourceIds(dir, 'cloudflare_zero_trust_dlp_predefined_profile', '--account', A, ids);

  await injectRulesetRulesGap(dir, 'account', 'accounts', A);
  patchSchemaGaps(dir);

  validateAndPrune(dir);
  if (IMPORT_MODE) await writeImports(dir, { accountId: CF_ACCOUNT_ID, zoneId: '' });
  logOk(`Account Terraform backup → ${dir}`);
}

// =============================================================================
// LISTS  (account-level — run once per backup, not once per zone)
// =============================================================================
async function backupLists(backupRoot) {
  const dir = path.join(backupRoot, 'account', 'lists');
  const dataDir = path.join(dir, 'data');
  setupTfDir(dir);
  fs.mkdirSync(dataDir, { recursive: true });

  logSection('Lists  (cf-terraforming + API item dump)');

  generateResource(dir, 'cloudflare_list', '--account', CF_ACCOUNT_ID);

  logInfo('  Fetching list items via API (cursor pagination) …');
  const lists = await cfApiList(`/accounts/${CF_ACCOUNT_ID}/rules/lists`);
  saveJson(path.join(dataDir, '_lists.json'), lists);
  if (lists === null) {
    logWarn('  Could not list lists — list items NOT backed up');
    validateAndPrune(dir);
    return;
  }
  logInfo(`  Found ${lists.length} list(s)`);

  // list_id → items file, consumed by writeListItems
  const index = {};
  for (const l of lists) {
    const listId = tsvVal(l.id);
    if (!listId) continue;
    const listName = tsvVal(l.name);
    const listKind = tsvVal(l.kind);
    const numItems = l.num_items === null || l.num_items === undefined || l.num_items === false
      ? 'null' : String(l.num_items);
    const items = await cfApiListCursor(`/accounts/${CF_ACCOUNT_ID}/rules/lists/${listId}/items`, ['result'], 500);
    const outFile = path.join(dataDir, `${safeName(listName, /[^a-zA-Z0-9_-]/g)}_${listKind}.json`);
    saveJson(outFile, items);
    if (!fs.existsSync(outFile)) continue;
    const got = jqLength(JSON.parse(fs.readFileSync(outFile, 'utf8')));
    if (numItems !== 'null' && got !== Number(numItems)) {
      logWarn(`    ${listName}: fetched ${got} items but the list reports num_items=${numItems}`);
    }
    index[listId] = outFile;
  }

  writeListItems(dir, index);

  validateAndPrune(dir);
  // Not plan-verified: see writeImports.
  if (IMPORT_MODE) await writeImports(dir, { accountId: CF_ACCOUNT_ID, zoneId: '' }, { verify: false });
  logOk(`Lists backup → ${dir}`);
}

// =============================================================================
// IP RESOURCES
// Both passes write into account/ip_resources/: the account-level pass (run
// once) as ip_access_rules_account.json, and the per-zone pass (run once per
// zone) as ip_access_rules_zone_<zone_name>.json.
// =============================================================================
async function backupIpResourcesAccount(backupRoot) {
  const dir = path.join(backupRoot, 'account', 'ip_resources');
  fs.mkdirSync(dir, { recursive: true });

  logSection('IP resources — account level  (API)');

  saveJson(path.join(dir, 'ip_access_rules_account.json'),
    await cfApiList(`/accounts/${CF_ACCOUNT_ID}/firewall/access_rules/rules`));

  const prefixes = await cfApiList(`/accounts/${CF_ACCOUNT_ID}/addressing/prefixes`);
  saveJson(path.join(dir, 'byoip_prefixes.json'), prefixes);

  for (const pfx of jqIter(prefixes)) {
    const pfxId = jqAlt(() => jqGet(pfx, ['id']), null);
    if (pfxId === null) continue;
    saveJson(path.join(dir, `byoip_bgp_prefixes_${jqRaw(pfxId)}.json`),
      await cfApiList(`/accounts/${CF_ACCOUNT_ID}/addressing/prefixes/${jqRaw(pfxId)}/bgp/prefixes`));
  }

  saveJson(path.join(dir, 'address_maps.json'), await cfApiList(`/accounts/${CF_ACCOUNT_ID}/addressing/address_maps`));

  logOk(`Account-level IP resources backup → ${dir}`);
}

async function backupIpResourcesZone(backupRoot, zoneName, zoneId) {
  const zoneSafe = safeName(zoneName, /[^a-zA-Z0-9._-]/g);
  const dir = path.join(backupRoot, 'account', 'ip_resources');
  fs.mkdirSync(dir, { recursive: true });

  logInfo(`  Zone IP access rules: ${zoneName} …`);
  saveJson(path.join(dir, `ip_access_rules_zone_${zoneSafe}.json`),
    await cfApiList(`/zones/${zoneId}/firewall/access_rules/rules`));
}

// =============================================================================
// API BACKUP
// Account-level pass (run once) writes into account/api_backup/; the per-zone
// "extras" pass (run once per zone) writes into account/api_backup/zone_<zone>/.
// The zone's Terraform HCL lives in its own top-level <zone_name>/ folder.
// =============================================================================
async function backupApiAccount(backupRoot) {
  const dir = path.join(backupRoot, 'account', 'api_backup');
  fs.mkdirSync(dir, { recursive: true });
  const A = CF_ACCOUNT_ID;
  const j = (f) => path.join(dir, f);

  logSection('API backup — account level  (supplementary — not in cf-terraforming)');

  saveJson(j('account_details.json'), await cfApi(`/accounts/${A}`), fResult);
  saveJson(j('account_subscriptions.json'), await cfApi(`/accounts/${A}/subscriptions`), fResult);
  saveJson(j('account_roles.json'), await cfApiList(`/accounts/${A}/roles`));
  saveJson(j('iam_permission_groups.json'), await cfApiList(`/accounts/${A}/iam/permission_groups`));
  saveJson(j('iam_resource_groups.json'), await cfApiList(`/accounts/${A}/iam/resource_groups`));

  // Audit logs: page/per_page pagination (there is no `limit` parameter —
  // https://developers.cloudflare.com/api/resources/audit_logs/methods/list/).
  logInfo(`  Audit logs (last ${AUDIT_LOG_HOURS}h) …`);
  const since = isoZ(new Date(Date.now() - Number(AUDIT_LOG_HOURS) * 3600 * 1000));
  saveJson(j('audit_logs.json'), await cfApiList(`/accounts/${A}/audit_logs?since=${since}&direction=desc`));

  saveJson(j('notification_policies.json'), await cfApiList(`/accounts/${A}/alerting/v3/policies`));
  saveJson(j('notification_webhooks.json'), await cfApiList(`/accounts/${A}/alerting/v3/destinations/webhooks`));
  saveJson(j('workers_kv_namespaces.json'), await cfApiList(`/accounts/${A}/storage/kv/namespaces`));
  saveJson(j('durable_object_namespaces.json'), await cfApiList(`/accounts/${A}/workers/durable_objects/namespaces`));
  saveJson(j('queues.json'), await cfApiList(`/accounts/${A}/queues`));
  saveJson(j('d1_databases.json'), await cfApiList(`/accounts/${A}/d1/database`));
  // R2: result is {"buckets":[...]}, cursor-paginated.
  saveJson(j('r2_buckets.json'), await cfApiListCursor(`/accounts/${A}/r2/buckets`, ['result', 'buckets'], 1000));
  // cloudflare_registrar_domain isn't in the provider v5 schema, so this JSON
  // is the only record of registrar settings (auto-renew, locks, …).
  saveJson(j('registrar_domains.json'), await cfApiList(`/accounts/${A}/registrar/domains`));

  const pagesProjects = await cfApiList(`/accounts/${A}/pages/projects`);
  saveJson(j('pages_projects.json'), pagesProjects);
  for (const proj of jqIter(pagesProjects)) {
    const projName = jqAlt(() => jqGet(proj, ['name']), null);
    if (projName === null) continue;
    saveJson(j(`pages_deployments_${safeName(jqRaw(projName), /[^a-zA-Z0-9_-]/g)}.json`),
      await cfApiList(`/accounts/${A}/pages/projects/${jqRaw(projName)}/deployments`));
  }

  // Worker scripts: cf-terraforming has no mapping for cloudflare_workers_script,
  // so the code and its settings (bindings, compatibility date, …) are saved
  // here. GET /workers/scripts/{name} returns the original upload — a single
  // script, or multipart/form-data for module Workers — byte-for-byte.
  const scriptsDir = j('workers_scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const scripts = await cfApiList(`/accounts/${A}/workers/scripts`);
  saveJson(path.join(scriptsDir, '_scripts.json'), scripts);
  for (const s of jqIter(scripts)) {
    const scriptName = jqAlt(() => jqGet(s, ['id']), null);
    if (scriptName === null) continue;
    const name = jqRaw(scriptName);
    const scriptSafe = safeName(name, /[^a-zA-Z0-9_.-]/g);
    logInfo(`  Worker script: ${name}`);
    await cfApiDownload(`/accounts/${A}/workers/scripts/${name}`, path.join(scriptsDir, `${scriptSafe}.script`));
    saveJson(path.join(scriptsDir, `${scriptSafe}.settings.json`),
      await cfApi(`/accounts/${A}/workers/scripts/${name}/settings`), fResult);
  }

  // Device (WARP) profiles and each custom profile's local-domain-fallback
  // list — cloudflare_zero_trust_device_custom_profile_local_domain_fallback
  // has no cf-terraforming mapping, so this JSON is its only backup.
  const deviceProfiles = await cfApi(`/accounts/${A}/devices/policies`);
  saveJson(j('device_profiles.json'), deviceProfiles, fResult);
  for (const dp of jqIter(jqAlt(() => jqGet(deviceProfiles, ['result']), null))) {
    if (!isObj(dp) || dp.default === true) continue;
    const policyId = jqAlt(() => jqGet(dp, ['policy_id']), null);
    if (policyId === null) continue;
    saveJson(j(`device_profile_${jqRaw(policyId)}_fallback_domains.json`),
      await cfApi(`/accounts/${A}/devices/policy/${jqRaw(policyId)}/fallback_domains`), fResult);
  }

  saveJson(j('magic_gre_tunnels.json'), await cfApi(`/accounts/${A}/magic/gre_tunnels`), jqFilter(['result', 'gre_tunnels']));
  saveJson(j('magic_ipsec_tunnels.json'), await cfApi(`/accounts/${A}/magic/ipsec_tunnels`), jqFilter(['result', 'ipsec_tunnels']));
  saveJson(j('magic_static_routes.json'), await cfApi(`/accounts/${A}/magic/routes`), jqFilter(['result', 'routes']));
  saveJson(j('zt_tunnel_routes.json'), await cfApiList(`/accounts/${A}/teamnet/routes?is_deleted=false`));
  saveJson(j('zt_virtual_networks.json'), await cfApiList(`/accounts/${A}/teamnet/virtual_networks?is_deleted=false`));

  logOk(`Account-level API backup → ${dir}`);
}

async function backupApiZone(backupRoot, zoneName, zoneId) {
  const zoneSafe = safeName(zoneName, /[^a-zA-Z0-9._-]/g);
  const zdir = path.join(backupRoot, 'account', 'api_backup', `zone_${zoneSafe}`);
  fs.mkdirSync(zdir, { recursive: true });
  const j = (f) => path.join(zdir, f);
  logInfo(`  Zone API extras: ${zoneName}`);

  saveJson(j('zone_settings_raw.json'), await cfApi(`/zones/${zoneId}/settings`), fResult);
  saveJson(j('dns_settings.json'), await cfApi(`/zones/${zoneId}/dns_settings`), fResult);
  saveJson(j('ssl_universal_settings.json'), await cfApi(`/zones/${zoneId}/ssl/universal/settings`), fResult);
  // `status=all` (not ssl_status) includes non-active packs.
  saveJson(j('ssl_certificate_packs.json'), await cfApiList(`/zones/${zoneId}/ssl/certificate_packs?status=all`));
  saveJson(j('dnssec.json'), await cfApi(`/zones/${zoneId}/dnssec`), fResult);
  saveJson(j('healthchecks.json'), await cfApiList(`/zones/${zoneId}/healthchecks`));
  saveJson(j('argo_smart_routing.json'), await cfApi(`/zones/${zoneId}/argo/smart_routing`), fResult);
  saveJson(j('argo_tiered_caching.json'), await cfApi(`/zones/${zoneId}/argo/tiered_caching`), fResult);
  saveJson(j('custom_certificates.json'), await cfApiList(`/zones/${zoneId}/custom_certificates`));
  saveJson(j('origin_ca_certificates.json'), await cfApiList(`/certificates?zone_id=${zoneId}`));
  saveJson(j('zaraz_config.json'), await cfApi(`/zones/${zoneId}/settings/zaraz/config`), fResult);
  saveJson(j('email_routing_settings.json'), await cfApi(`/zones/${zoneId}/email/routing`), fResult);
  saveJson(j('rulesets_inventory.json'), await cfApiList(`/zones/${zoneId}/rulesets`));
  saveJson(j('logpush_jobs.json'), await cfApiList(`/zones/${zoneId}/logpush/jobs`));
  saveJson(j('zone_subscription.json'), await cfApi(`/zones/${zoneId}/subscription`), fResult);

  logOk(`  Zone API extras backup → ${zdir}`);
}

// =============================================================================
// IMPORT MODE  (--import / --mode import / BACKUP_MODE=import)
// -----------------------------------------------------------------------
// After a Terraform directory is generated and validated, writes imports.tf:
// one Terraform 1.5+ `import {}` block per generated resource, so the backup
// can be adopted into Terraform state with `terraform plan` / `terraform apply`
// instead of re-creating everything.
//
// Import IDs are NOT taken from `cf-terraforming import`: on this provider
// version it emits wrong IDs for many types (other zones' rulesets, setting
// names where a zone ID is needed, a UUID where Pages wants the project name,
// R2 buckets without jurisdiction, …). Instead each ID is built from the
// provider's documented import format (IMPORT_ID_FORMATS, from the v5.28.1
// docs), filled from the block's own attributes, the API ID cf-terraforming
// embeds in each resource label, or — where neither carries the object's ID —
// an API lookup by name (IMPORT_ID_LOOKUPS).
//
// imports.tf is then checked with a READ-ONLY `terraform plan` (it only reads
// from the API; nothing is applied and no state is written). Imports Terraform
// cannot read are removed and recorded. <dir>/_import_report.txt lists:
// resources `terraform apply` would REPLACE (destroy + re-create), CHANGE
// (live config differs from the backup) or CREATE (no import possible), and
// skipped/removed imports with reasons. Review it before `terraform apply`.
// =============================================================================

// From terraform-provider-cloudflare v5.28.1 docs, "Import" section.
const IMPORT_ID_FORMATS = {
  cloudflare_access_rule: '<{accounts|zones}/{account_id|zone_id}>/<rule_id>',
  cloudflare_account: '<account_id>',
  cloudflare_account_member: '<account_id>/<member_id>',
  cloudflare_ai_gateway: '<account_id>/<id>',
  cloudflare_api_shield: '<zone_id>',
  cloudflare_api_shield_operation: '<zone_id>/<operation_id>',
  cloudflare_api_shield_operation_schema_validation_settings: '<zone_id>/<operation_id>',
  cloudflare_api_shield_schema_validation_settings: '<zone_id>',
  cloudflare_argo_smart_routing: '<zone_id>',
  cloudflare_argo_tiered_caching: '<zone_id>',
  cloudflare_authenticated_origin_pulls: '<zone_id>/<hostname>',
  cloudflare_authenticated_origin_pulls_certificate: '<zone_id>/<certificate_id>',
  cloudflare_authenticated_origin_pulls_settings: '<zone_id>',
  cloudflare_bot_management: '<zone_id>',
  cloudflare_calls_turn_app: '<account_id>/<key_id>',
  cloudflare_certificate_pack: '<zone_id>/<certificate_pack_id>',
  cloudflare_custom_hostname: '<zone_id>/<custom_hostname_id>',
  cloudflare_custom_hostname_fallback_origin: '<zone_id>',
  cloudflare_custom_pages: '<{accounts|zones}/{account_id|zone_id}>/<identifier>',
  cloudflare_d1_database: '<account_id>/<database_id>',
  cloudflare_dns_record: '<zone_id>/<dns_record_id>',
  cloudflare_dns_zone_transfers_incoming: '<zone_id>',
  cloudflare_dns_zone_transfers_outgoing: '<zone_id>',
  cloudflare_email_routing_catch_all: '<zone_id>',
  cloudflare_email_routing_dns: '<zone_id>',
  cloudflare_email_routing_rule: '<zone_id>/<rule_identifier>',
  cloudflare_email_routing_settings: '<zone_id>',
  cloudflare_healthcheck: '<zone_id>/<healthcheck_id>',
  cloudflare_hostname_tls_setting: '<zone_id>/<setting_id>/<hostname>',
  cloudflare_keyless_certificate: '<zone_id>/<keyless_certificate_id>',
  cloudflare_leaked_credential_check: '<zone_id>',
  cloudflare_leaked_credential_check_rule: '<zone_id>/<detection_id>',
  cloudflare_list: '<account_id>/<list_id>',
  cloudflare_list_item: '<account_id>/<list_id>/<item_id>',
  cloudflare_load_balancer: '<zone_id>/<load_balancer_id>',
  cloudflare_load_balancer_monitor: '<account_id>/<monitor_id>',
  cloudflare_logpull_retention: '<zone_id>',
  cloudflare_logpush_job: '<{accounts|zones}/{account_id|zone_id}>/<job_id>',
  cloudflare_managed_transforms: '<zone_id>',
  cloudflare_mtls_certificate: '<account_id>/<mtls_certificate_id>',
  cloudflare_notification_policy: '<account_id>/<policy_id>',
  cloudflare_observatory_scheduled_test: '<zone_id>/<url>',
  cloudflare_page_rule: '<zone_id>/<pagerule_id>',
  cloudflare_page_shield_policy: '<zone_id>/<policy_id>',
  cloudflare_pages_domain: '<account_id>/<project_name>/<domain_name>',
  cloudflare_pages_project: '<account_id>/<project_name>',
  cloudflare_queue: '<account_id>/<queue_id>',
  cloudflare_r2_bucket: '<account_id>/<bucket_name>/<jurisdiction>',
  cloudflare_regional_hostname: '<zone_id>/<hostname>',
  cloudflare_regional_tiered_cache: '<zone_id>',
  cloudflare_ruleset: '<{accounts|zones}/{account_id|zone_id}>/<ruleset_id>',
  cloudflare_snippet: '<zone_id>/<snippet_name>',
  cloudflare_snippet_rules: '<zone_id>',
  cloudflare_spectrum_application: '<zone_id>/<app_id>',
  cloudflare_tiered_cache: '<zone_id>',
  cloudflare_total_tls: '<zone_id>',
  cloudflare_turnstile_widget: '<account_id>/<sitekey>',
  cloudflare_universal_ssl_setting: '<zone_id>',
  cloudflare_url_normalization_settings: '<zone_id>',
  cloudflare_waiting_room: '<zone_id>/<waiting_room_id>',
  cloudflare_waiting_room_event: '<zone_id>/<waiting_room_id>/<event_id>',
  cloudflare_waiting_room_rules: '<zone_id>/<waiting_room_id>',
  cloudflare_waiting_room_settings: '<zone_id>',
  cloudflare_web3_hostname: '<zone_id>/<identifier>',
  cloudflare_web_analytics_site: '<account_id>/<site_id>',
  cloudflare_workers_cron_trigger: '<account_id>/<script_name>',
  cloudflare_workers_deployment: '<account_id>/<script_name>/<deployment_id>',
  cloudflare_workers_kv_namespace: '<account_id>/<namespace_id>',
  cloudflare_workers_route: '<zone_id>/<route_id>',
  cloudflare_workers_script_subdomain: '<account_id>/<script_name>',
  cloudflare_zero_trust_access_application: '<{accounts|zones}/{account_id|zone_id}>/<app_id>',
  cloudflare_zero_trust_access_group: '<{accounts|zones}/{account_id|zone_id}>/<group_id>',
  cloudflare_zero_trust_access_identity_provider: '<{accounts|zones}/{account_id|zone_id}>/<identity_provider_id>',
  cloudflare_zero_trust_access_key_configuration: '<account_id>',
  cloudflare_zero_trust_access_mtls_certificate: '<{accounts|zones}/{account_id|zone_id}>/<certificate_id>',
  cloudflare_zero_trust_access_mtls_hostname_settings: '<{accounts|zones}/{account_id|zone_id}>',
  cloudflare_zero_trust_access_policy: '<account_id>/<policy_id>',
  cloudflare_zero_trust_access_service_token: '<{accounts|zones}/{account_id|zone_id}>/<service_token_id>',
  cloudflare_zero_trust_access_short_lived_certificate: '<{accounts|zones}/{account_id|zone_id}>/<app_id>',
  cloudflare_zero_trust_access_tag: '<account_id>/<tag_name>',
  cloudflare_zero_trust_device_custom_profile: '<account_id>/<policy_id>',
  cloudflare_zero_trust_device_default_profile: '<account_id>',
  cloudflare_zero_trust_device_default_profile_local_domain_fallback: '<account_id>',
  cloudflare_zero_trust_device_managed_networks: '<account_id>/<network_id>',
  cloudflare_zero_trust_device_posture_rule: '<account_id>/<rule_id>',
  cloudflare_zero_trust_dlp_predefined_profile: '<account_id>/<profile_id>',
  cloudflare_zero_trust_dns_location: '<account_id>/<location_id>',
  cloudflare_zero_trust_gateway_certificate: '<account_id>/<certificate_id>',
  cloudflare_zero_trust_gateway_logging: '<account_id>',
  cloudflare_zero_trust_gateway_policy: '<account_id>/<rule_id>',
  cloudflare_zero_trust_gateway_settings: '<account_id>',
  cloudflare_zero_trust_organization: '<account_id>',
  cloudflare_zero_trust_tunnel_cloudflared: '<account_id>/<tunnel_id>',
  cloudflare_zero_trust_tunnel_cloudflared_config: '<account_id>/<tunnel_id>',
  cloudflare_zero_trust_tunnel_cloudflared_route: '<account_id>/<route_id>',
  cloudflare_zero_trust_tunnel_cloudflared_virtual_network: '<account_id>/<virtual_network_id>',
  cloudflare_zone: '<zone_id>',
  cloudflare_zone_cache_reserve: '<zone_id>',
  cloudflare_zone_cache_variants: '<zone_id>',
  cloudflare_zone_dnssec: '<zone_id>',
  cloudflare_zone_hold: '<zone_id>',
  cloudflare_zone_lockdown: '<zone_id>/<lock_downs_id>',
  cloudflare_zone_setting: '<zone_id>/<setting_id>',
};

// Documented as "does not currently support terraform import" (v5.28.1).
const NO_IMPORT_TYPES = new Set([
  'cloudflare_ai_search_namespace', 'cloudflare_api_shield_discovery_operation', 'cloudflare_calls_sfu_app',
  'cloudflare_content_scanning_expression', 'cloudflare_queue_consumer', 'cloudflare_r2_custom_domain',
  'cloudflare_r2_managed_domain', 'cloudflare_stream_live_input', 'cloudflare_user',
  'cloudflare_web_analytics_rule', 'cloudflare_zero_trust_device_default_profile_certificates',
  'cloudflare_zero_trust_risk_behavior', 'cloudflare_zone_dns_settings',
]);

// Importable per the docs, but import is broken in the current provider.
const SKIP_IMPORT = {
  // ImportState leaves `metadata` unset and Read then dereferences it — the
  // provider panics on every snippet import (v5.28.1 and main;
  // cloudflare/terraform-provider-cloudflare#7378, fix #7424 not merged).
  cloudflare_snippet: 'import crashes the provider (nil metadata in Read, terraform-provider-cloudflare#7378); '
    + 'not needed — apply creates it with PUT /snippets/{name}, overwriting the live snippet in place',
};

// Notes shown next to plan actions in the report.
const APPLY_NOTES = {
  'create cloudflare_snippet': 'in-place overwrite of the live snippet (create is a PUT by name) — no duplicate',
  'update cloudflare_snippet_rules': 'provider does not read rules back on import; apply re-writes the same rules',
};

// Format placeholders that are a differently-named attribute in the block.
const IMPORT_ATTR_ALIASES = {
  cloudflare_pages_project: { project_name: 'name' },
  cloudflare_pages_domain: { domain_name: 'name' },
  cloudflare_r2_bucket: { bucket_name: 'name' },
  cloudflare_zero_trust_access_tag: { tag_name: 'name' },
};

// Types whose cf-terraforming label carries the ACCOUNT ID instead of the
// object's own ID, and whose ID isn't in the generated config either: the ID
// is looked up via the API by a unique attribute.
const IMPORT_ID_LOOKUPS = {
  cloudflare_d1_database: { path: (a) => `/accounts/${a}/d1/database`, attr: 'name', key: (o) => o.name, id: (o) => o.uuid },
  cloudflare_queue: { path: (a) => `/accounts/${a}/queues`, attr: 'queue_name', key: (o) => o.queue_name, id: (o) => o.queue_id },
  cloudflare_turnstile_widget: { path: (a) => `/accounts/${a}/challenges/widgets`, attr: 'name', key: (o) => o.name, id: (o) => o.sitekey },
  cloudflare_calls_turn_app: { path: (a) => `/accounts/${a}/calls/turn_keys`, attr: 'name', key: (o) => o.name, id: (o) => o.uid },
  cloudflare_zero_trust_device_managed_networks: { path: (a) => `/accounts/${a}/devices/networks`, attr: 'name', key: (o) => o.name, id: (o) => o.network_id },
  cloudflare_zero_trust_device_custom_profile: { path: (a) => `/accounts/${a}/devices/policies`, attr: 'name', key: (o) => o.name, id: (o) => o.policy_id },
  cloudflare_web_analytics_site: {
    path: (a) => `/accounts/${a}/rum/site_info/list`, attr: 'zone_tag',
    key: (o) => (isObj(o.ruleset) ? o.ruleset.zone_tag : null) ?? o.zone_tag, id: (o) => o.site_tag,
  },
};

// Lookup tables are fetched once per run: type → Map(key → id | null if ambiguous)
const importLookupCache = new Map();
async function importLookup(type, accountId) {
  if (importLookupCache.has(type)) return importLookupCache.get(type);
  const spec = IMPORT_ID_LOOKUPS[type];
  const items = await cfApiList(spec.path(accountId));
  const map = new Map();
  for (const o of jqIter(items).filter(isObj)) {
    const k = jqAlt(() => spec.key(o), null);
    const v = jqAlt(() => spec.id(o), null);
    if (k === null || v === null) continue;
    map.set(String(k), map.has(String(k)) ? null : String(v)); // duplicate key → ambiguous
  }
  importLookupCache.set(type, map);
  return map;
}

// Top-level `key = "string"` attributes of an fmt'd resource block.
function blockStringAttrs(block) {
  const attrs = {};
  for (const m of block.matchAll(/^ {2}([a-z_0-9]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/gm)) {
    attrs[m[1]] = jqAlt(() => JSON.parse(m[2].split('$${').join('${').split('%%{').join('%{')), null);
  }
  return attrs;
}

// → {id} or {skip: reason}
async function importIdFor(type, label, block, scope) {
  if (NO_IMPORT_TYPES.has(type)) return { skip: 'provider does not support import for this type' };
  if (hasOwn(SKIP_IMPORT, type)) return { skip: SKIP_IMPORT[type] };
  const format = IMPORT_ID_FORMATS[type];
  if (!format) return { skip: 'no documented import ID format' };
  const attrs = blockStringAttrs(block);
  const acct = attrs.account_id || scope.accountId;
  const zone = attrs.zone_id || scope.zoneId;
  const labelId = label.replace(/^terraform_managed_resource_/, '').replace(/_\d+$/, '');
  const tokens = [...format.matchAll(/<([^>]+)>/g)].map((m) => m[1]);
  if (tokens.length === 1 && tokens[0] === 'account_id' && !attrs.account_id && attrs.zone_id) {
    return { skip: 'import only supported at account scope (this is a zone-scoped block)' };
  }
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const isLast = i === tokens.length - 1;
    let v = null;
    if (tok === '{accounts|zones}/{account_id|zone_id}') v = attrs.account_id ? `accounts/${attrs.account_id}` : `zones/${zone}`;
    else if (tok === 'zone_id') v = zone;
    else if (tok === 'account_id') v = acct;
    else if (tok === 'jurisdiction') v = attrs.jurisdiction || 'default';
    else if ((IMPORT_ATTR_ALIASES[type] || {})[tok]) v = attrs[IMPORT_ATTR_ALIASES[type][tok]] ?? null;
    else if (attrs[tok]) v = attrs[tok];
    else if (type === 'cloudflare_list_item' && tok === 'list_id') {
      const ref = /^ {2}list_id\s*=\s*cloudflare_list\.terraform_managed_resource_([0-9a-f]{32})_\d+\.id/m.exec(block);
      v = ref ? ref[1] : null;
    } else if (isLast && IMPORT_ID_LOOKUPS[type]) {
      const spec = IMPORT_ID_LOOKUPS[type];
      const key = attrs[spec.attr];
      const map = await importLookup(type, acct);
      v = key && map.has(key) ? map.get(key) : null;
      if (key && map.has(key) && v === null) return { skip: `more than one object named "${key}" — import ID ambiguous` };
    } else if (isLast && labelId && labelId !== acct && labelId !== zone) {
      v = labelId;
    }
    if (!v) return { skip: `could not determine <${tok}> for the import ID` };
    parts.push(v);
  }
  return { id: parts.join('/') };
}

const TRANSIENT_PLAN_ERROR = /\b(429 Too Many Requests|50[0-4] [A-Z][A-Za-z ]+)\b|rate limit/i;

const importBlock = (to, id) => `import {\n  to = ${to}\n  id = ${hclString(id)}\n}\n`;

// Read-only plan in <dir>; returns {msgs: parsed JSON-lines messages, stderr}.
function planJson(dir) {
  const r = run(TF_BINARY, ['plan', '-input=false', '-lock=false', '-json'], { cwd: dir });
  return { msgs: r.stdout.split('\n').filter(Boolean).map((l) => jqAlt(() => JSON.parse(l), null)).filter(Boolean), stderr: r.stderr };
}

// writeImports(dir, scope, {verify}) — see IMPORT MODE above.
// verify: true (default) checks imports.tf with a read-only plan; false skips
// it (lists: the provider reads and diffs every item of every list, which
// takes well over 30 minutes for a list of ~10k items).
async function writeImports(dir, scope, { verify = true } = {}) {
  logSection(`  Import blocks: ${path.basename(dir)}`);
  const imports = new Map(); // address → id
  const skipped = [];        // [address, reason]
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.tf') && f !== 'provider.tf' && f !== 'imports.tf').sort()) {
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n');
    for (const [s, e] of resourceBlocks(lines)) {
      const head = /^resource "([^"]+)" "([^"]+)"/.exec(lines[s]);
      if (!head) continue;
      const address = `${head[1]}.${head[2]}`;
      const res = await importIdFor(head[1], head[2], lines.slice(s, e + 1).join('\n'), scope);
      if (res.id) imports.set(address, res.id);
      else skipped.push([address, res.skip]);
    }
  }
  const writeFile = () => fs.writeFileSync(path.join(dir, 'imports.tf'),
    [...imports].map(([to, id]) => importBlock(to, id)).join('\n'));
  writeFile();
  logInfo(`  ${imports.size} import block(s) written, ${skipped.length} resource(s) not importable`);

  // ── Verify with a read-only plan; drop imports Terraform cannot read ──────
  const removed = []; // [address, reason]
  let msgs = [];
  let planOk = false;
  for (let pass = 1; verify && pass <= 5; pass++) {
    logInfo(`  verifying with read-only terraform plan (pass ${pass}) …`);
    const plan = planJson(dir);
    msgs = plan.msgs;
    // A provider panic (e.g. v5.28.1 crashes in cloudflare_snippet's Read on
    // import) cancels every other request in the plan: drop all imports of the
    // type named in the stack trace and re-plan.
    const crash = /^panic:[\s\S]*?\/internal\/services\/([a-z0-9_]+)\//m.exec(plan.stderr);
    if (crash) {
      const rtype = `cloudflare_${crash[1]}`;
      const hits = [...imports.keys()].filter((a) => a.split('.')[0] === rtype);
      if (hits.length) {
        for (const a of hits) {
          removed.push([a, `provider crashed (panic) reading ${rtype} on import — a provider bug; import it manually once fixed`]);
          imports.delete(a);
        }
        logWarn(`  provider crashed reading ${rtype} — removed its ${hits.length} import(s) and re-planning`);
        writeFile();
        continue;
      }
    }
    const errs = msgs.filter((m) => m.type === 'diagnostic' && m.diagnostic && m.diagnostic.severity === 'error').map((m) => m.diagnostic);
    if (!errs.length) {
      planOk = msgs.some((m) => m.type === 'change_summary');
      if (!planOk) logWarn('  terraform plan produced no result — imports.tf kept unverified');
      break;
    }
    let dropped = 0;
    let transient = false;
    for (const d of errs) {
      const text = `${d.summary || ''} ${d.detail || ''}`;
      // Rate limits / server errors say nothing about the import ID: never
      // drop an import for them, re-plan instead.
      if (TRANSIENT_PLAN_ERROR.test(text)) {
        transient = true;
        continue;
      }
      // Attribute the error to an import: by address, by the import ID quoted
      // in "got …", or by an ID segment appearing in the failing API URL.
      let hit = d.address && imports.has(d.address) ? d.address : null;
      if (!hit) {
        const got = /got "([^"]+)"/.exec(text);
        if (got) hit = [...imports].find(([, id]) => id === got[1])?.[0] ?? null;
      }
      if (!hit) {
        hit = [...imports].find(([, id]) => id.split('/').filter((seg) => seg.length >= 8 && seg !== scope.accountId && seg !== scope.zoneId)
          .some((seg) => text.includes(seg)))?.[0] ?? null;
      }
      if (hit && imports.has(hit)) {
        removed.push([hit, `${d.summary}: ${(d.detail || '').replace(/\s+/g, ' ').slice(0, 160)}`]);
        imports.delete(hit);
        dropped++;
      }
    }
    if (!dropped && transient) {
      logWarn('  plan hit API rate limits / server errors — waiting 60s and re-planning');
      await sleep(60000);
      continue;
    }
    if (!dropped) {
      logWarn('  plan errors could not be tied to an import block — imports.tf kept unverified:');
      for (const d of errs) emit(process.stderr, `    ${d.summary}: ${(d.detail || '').replace(/\s+/g, ' ').slice(0, 200)}`);
      break;
    }
    logWarn(`  removed ${dropped} import(s) Terraform could not read`);
    writeFile();
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const changes = msgs.filter((m) => m.type === 'planned_change' && m.change && m.change.resource);
  const byAction = (act) => changes.filter((m) => m.change.action === act)
    .map((m) => {
      let note = APPLY_NOTES[`${act} ${m.change.resource.resource_type}`];
      if (act === 'replace' && m.change.reason) note = m.change.reason;
      return m.change.resource.addr + (note ? `\t(${note})` : '');
    }).sort();
  const summaryMsg = msgs.find((m) => m.type === 'change_summary');
  const cs = (summaryMsg && summaryMsg.changes) || {};
  const pending = [verify ? '(plan did not complete)' : '(not checked — verification plan skipped)'];
  const report = [
    `Import report — ${path.basename(dir)} — ${dateU()}`,
    '',
    `imports.tf blocks            : ${imports.size}${verify ? '' : '  (not plan-verified)'}`,
    `Not importable               : ${skipped.length}`,
    `Removed (Terraform could not read the ID): ${removed.length}`,
    planOk ? `Read-only plan               : ${cs.import ?? 0} to import, ${cs.change ?? 0} to change, ${cs.add ?? 0} to add, ${cs.remove ?? 0} to destroy`
      : !verify ? 'Read-only plan               : skipped — the provider reads every item of every list, which takes'
        + '\n                               far too long for large lists; run `terraform plan` yourself before applying'
        : 'Read-only plan               : did not complete cleanly (see the backup log)',
    '',
    'Running `terraform apply` here imports the resources AND applies the changes',
    'listed below. Review `terraform plan` before applying.',
    '',
    '── Would be REPLACED on apply (DESTROYED and re-created — check each before applying) ──',
    ...(planOk ? byAction('replace') : pending),
    '',
    '── Would be CHANGED on apply (live config differs from this backup) ──',
    ...(planOk ? byAction('update') : pending),
    '',
    '── Would be CREATED on apply (no import — would duplicate or fail) ──',
    ...(planOk ? byAction('create') : pending),
    '',
    '── Not importable ──',
    ...skipped.map(([a, r]) => `${a}\t${r}`),
    '',
    '── Removed after plan ──',
    ...removed.map(([a, r]) => `${a}\t${r}`),
  ];
  fs.writeFileSync(path.join(dir, '_import_report.txt'), `${report.join('\n')}\n`);

  const line = `  imports.tf: ${imports.size} import(s); ${skipped.length} not importable, ${removed.length} removed — see _import_report.txt`;
  if (planOk) {
    logOk(line);
    logInfo(`  plan: ${cs.import ?? 0} to import, ${cs.change ?? 0} to change, ${cs.add ?? 0} to add, ${cs.remove ?? 0} to destroy`);
    const nRep = byAction('replace').length;
    if (nRep) logWarn(`  ${nRep} resource(s) would be REPLACED (destroyed + re-created) on apply — see _import_report.txt`);
  } else if (!verify) {
    logInfo(line);
    logInfo('  not plan-verified (too slow for large lists) — run terraform plan before applying');
  } else {
    logWarn(line);
  }
}

// ==== UPLOADS BEGIN ==========================================================
// =============================================================================
// R2 BUCKET LOCK
// https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/locks/
// GET/PUT /accounts/{account_id}/r2/buckets/{bucket_name}/lock via the
// Cloudflare API (CF_API_TOKEN) — separate from the R2 S3 keys used to upload.
// =============================================================================
const r2LockPath = () => `/accounts/${encodeURIComponent(CF_ACCOUNT_ID)}/r2/buckets/${encodeURIComponent(R2_BUCKET_NAME)}/lock`;

// This run's lock state. `engaged` once r2Unlock started (nothing to restore
// before that); `saved` = the rules the bucket had before (null = unreadable);
// `cleared` once this run may have removed them; `restore` = the one restore
// promise every exit path (normal finish, signal, crash) shares.
const r2Lock = { engaged: false, saved: null, cleared: false, restore: null };
let r2Guards = null;

// Current rules, or null when they could not be read.
async function r2GetLockRules() {
  const resp = await cfApi(r2LockPath());
  if (!(isObj(resp) && resp.success === true)) {
    logWarn(`  [R2] Could not fetch lock rules: ${jqAlt(() => errMessage(resp), 'unknown error')}`);
    return null;
  }
  const rules = jqAlt(() => jqGet(resp, ['result', 'rules']), []);
  return Array.isArray(rules) ? rules : null;
}

async function r2SetLockRules(rules) {
  const resp = await cfApi(r2LockPath(), { method: 'PUT', body: JSON.stringify({ rules }) });
  if (!(isObj(resp) && resp.success === true)) {
    logError(`  [R2] Failed to set lock rules: ${jqAlt(() => errMessage(resp), 'unknown error')}`);
    return false;
  }
  return true;
}

// Rules from R2_LOCK_RULES_FILE, or null when there is no (valid) file.
function r2ConfiguredLockRules() {
  if (!fs.existsSync(R2_LOCK_RULES_FILE)) return null;
  const rules = jqAlt(() => JSON.parse(fs.readFileSync(R2_LOCK_RULES_FILE, 'utf8')).rules, null);
  return Array.isArray(rules) ? rules : null;
}

// While the bucket is unlocked, a signal or crash must put the rules back
// before the process goes. Repeated signals just wait for the same restore.
// stdout/stderr errors (EPIPE once the console has gone) are swallowed so they
// cannot turn into uncaught exceptions mid-restore; the logfile still gets it.
function r2InstallGuards() {
  if (r2Guards) return;
  const finish = (code) => r2RestoreLock().then((ok) => process.exit(ok ? code : 1), () => process.exit(1));
  let reported = false;
  const onSignal = (sig) => {
    if (!reported) logError(`Received ${sig} while R2 bucket '${R2_BUCKET_NAME}' is unlocked — restoring its lock rules before exiting …`);
    reported = true;
    finish(128 + (os.constants.signals[sig] || 1));
  };
  const onCrash = (err) => {
    if (!reported) logError(`ABORTED while R2 bucket '${R2_BUCKET_NAME}' is unlocked: ${err && err.message ? err.message : err} — restoring its lock rules …`);
    reported = true;
    finish(1);
  };
  const quiet = () => {};
  r2Guards = { onSignal, onCrash, quiet };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  process.stdout.on('error', quiet);
  process.stderr.on('error', quiet);
}

// Windows cannot deliver a catchable signal (the console's cancel is a forced kill), so the console
// first asks over IPC. While the bucket is unlocked the answer is "wait": the rules go back, then
// the process exits; otherwise the console kills the process tree at once.
if (process.send) {
  process.channel?.unref();
  process.on('message', (m) => {
    if (!m || m.type !== 'cancel') return;
    const unlocked = !!r2Guards;
    try { process.send({ type: 'cancel-ack', unlocked }); } catch { /* console gone */ }
    if (unlocked) r2Guards.onSignal('SIGTERM');
  });
}

function r2RemoveGuards() {
  if (!r2Guards) return;
  const { onSignal, onCrash, quiet } = r2Guards;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(sig, onSignal);
  process.off('uncaughtException', onCrash);
  process.off('unhandledRejection', onCrash);
  process.stdout.off('error', quiet);
  process.stderr.off('error', quiet);
  r2Guards = null;
}

// Saves the bucket's current rules, then clears them so the bucket accepts
// writes during upload. Rules that cannot be read are left in place (writes to
// new keys still work; only overwrites/deletes are blocked).
async function r2Unlock() {
  r2Lock.engaged = true;
  logSection(`R2: unlocking bucket '${R2_BUCKET_NAME}'`);
  const existing = await r2GetLockRules();
  if (existing === null) {
    logWarn('  Could not read the current lock rules — leaving them in place (not unlocking)');
    return;
  }
  r2Lock.saved = existing;
  if (existing.length === 0) {
    logInfo('  Bucket has no lock rules — nothing to remove');
    return;
  }
  logInfo(`  Saved ${existing.length} existing lock rule(s); removing them for the upload …`);
  // Guard before the PUT: a signal while it is in flight must still restore.
  r2Lock.cleared = true;
  r2InstallGuards();
  if (await r2SetLockRules([])) {
    logOk('  Bucket unlocked (lock rules cleared)');
  } else {
    logError('  Could not unlock bucket — aborting upload to avoid data loss');
    exitNow(1);
  }
}

// Puts the lock policy back: the rules in R2_LOCK_RULES_FILE when it has any,
// else exactly the rules saved by r2Unlock — never less protected than before.
// Idempotent — every caller gets the same promise. Resolves true when the
// bucket is locked as intended (or there was nothing to do), false on failure.
function r2RestoreLock() {
  if (!r2Lock.engaged || R2_SKIP_UPLOAD === 'true') return Promise.resolve(true);
  if (!r2Lock.restore) {
    r2Lock.restore = r2DoRestore().catch((err) => {
      logError(`  [R2] Restoring lock rules threw: ${err && err.message ? err.message : err}`);
      return false;
    }).then((ok) => { r2RemoveGuards(); return ok; });
  }
  return r2Lock.restore;
}

async function r2DoRestore() {
  const configured = r2ConfiguredLockRules();
  let desired;
  let source;
  if (configured && configured.length) {
    desired = configured;
    source = R2_LOCK_RULES_FILE;
  } else if (r2Lock.cleared && r2Lock.saved && r2Lock.saved.length) {
    desired = r2Lock.saved;
    source = "the bucket's original rules (no rules configured)";
  } else {
    logInfo(`  R2: no lock rules configured and the bucket had none to restore on '${R2_BUCKET_NAME}' — leaving it as it was`);
    return true;
  }
  logSection(`R2: re-locking bucket '${R2_BUCKET_NAME}'`);
  logInfo(`  Applying ${desired.length} lock rule(s) from ${source} …`);
  let applied = false;
  for (let attempt = 1; attempt <= 3 && !applied; attempt++) {
    if (attempt > 1) {
      logWarn(`  Re-lock attempt ${attempt}/3 …`);
      await sleep((attempt - 1) * 3000);
    }
    applied = await r2SetLockRules(desired);
  }
  if (applied) {
    // Read back: a PUT that "succeeded" but left fewer rules is still a failure.
    const now = await r2GetLockRules();
    if (now !== null && now.length < desired.length) {
      logError(`  [R2] Bucket reports ${now.length} lock rule(s) after re-lock, expected ${desired.length}`);
      applied = false;
    }
  }
  if (applied) {
    logOk('  Lock rules applied — bucket is locked again');
    return true;
  }
  logError(`  CRITICAL: Failed to re-lock bucket '${R2_BUCKET_NAME}' — it may be UNLOCKED. This run is marked failed.`);
  logError('  Re-apply manually via the Cloudflare dashboard. Desired rules:');
  emit(process.stderr, JSON.stringify(desired, null, 2));
  return false;
}

// =============================================================================
// S3-COMPATIBLE UPLOAD HELPERS (R2 and AWS S3)
// AWS Signature Version 4, signed in-process (the bash version used
// `curl --aws-sigv4`). Keys are sent in signed request headers only.
// =============================================================================
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Signs one request. `headers` (lowercase names) are all signed; returns the
// Authorization header value. `amzDate` is YYYYMMDDTHHMMSSZ.
function sigV4Authorization({ method, canonicalUri, query = '', headers, payloadHash, region, service = 's3',
  accessKey, secretKey, amzDate }) {
  const dateStamp = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function s3Request({ method, url, region, accessKey, secretKey, body = Buffer.alloc(0), extraHeaders = {} }) {
  const u = new URL(url);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const payloadHash = sha256Hex(body);
  const signed = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  // Canonical query: RFC 3986-encoded name=value pairs sorted by name.
  const query = [...u.searchParams].map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const authorization = sigV4Authorization({
    method, canonicalUri: u.pathname, query, headers: signed, payloadHash, region, accessKey, secretKey, amzDate,
  });
  return fetch(url, {
    method,
    headers: { ...extraHeaders, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, Authorization: authorization },
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
}

const s3Path = (key) => key.split('/').map(uriEncode).join('/');

// Content-Type by extension, so objects open as text in the bucket browser on every OS
// (the `file` command this used to rely on does not exist on Windows, which left
// everything as application/octet-stream).
const CONTENT_TYPES = {
  '.tf': 'text/plain; charset=utf-8',
  '.tfvars': 'text/plain; charset=utf-8',
  '.hcl': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.tfstate': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
};
const contentTypeFor = (filepath) => CONTENT_TYPES[path.extname(filepath).toLowerCase()] || 'application/octet-stream';

// Only Terraform configuration goes offsite; JSON exports, logs, state and reports stay local.
const UPLOAD_EXTENSIONS = ['.tf'];
const isUploadable = (filepath) => UPLOAD_EXTENSIONS.includes(path.extname(filepath).toLowerCase());

// S3 error bodies are XML; only <Code>/<Message> are logged (other fields can
// echo the access key ID back).
function s3ErrorText(code, body) {
  if (code === '000') return 'network error';
  const c = /<Code>([^<]*)<\/Code>/.exec(body || '');
  const m = /<Message>([^<]*)<\/Message>/.exec(body || '');
  return c ? `${c[1]}${m ? `: ${m[1]}` : ''}`.slice(0, 300) : 'no error details';
}

const UPLOAD_ATTEMPTS = 3;
// Network errors, 408, 429 and 5xx are worth retrying; other 4xx (bad keys,
// no permission, no such bucket) will not get better.
const transientS3 = (code) => code === '000' || code === '408' || code === '429' || code.startsWith('5');

// Generic single-object PUT with bounded retry. Used by both R2 and S3 paths.
async function putObject(data, mime, objectKey, endpointUrl, bucket, accessKey, secretKey, region) {
  for (let attempt = 1; ; attempt++) {
    let code = '000';
    let body = '';
    try {
      const r = await s3Request({
        method: 'PUT',
        url: `${endpointUrl}/${s3Path(bucket)}/${s3Path(objectKey)}`,
        region, accessKey, secretKey,
        body: data,
        extraHeaders: { 'Content-Type': mime },
      });
      code = String(r.status);
      body = await r.text();
    } catch { /* network error → 000 */ }
    if (code === '200') {
      logOk(`    [${code}] ${objectKey}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return true;
    }
    if (!transientS3(code) || attempt >= UPLOAD_ATTEMPTS) {
      logWarn(`    [${code}] ${objectKey} — ${s3ErrorText(code, body)}${attempt > 1 ? ` (gave up after ${attempt} attempts)` : ''}`);
      return false;
    }
    logWarn(`    [${code}] ${objectKey} — ${s3ErrorText(code, body)}; retry ${attempt}/${UPLOAD_ATTEMPTS - 1} …`);
    await sleep(attempt * 2000);
  }
}

async function uploadFile(filepath, objectKey, endpointUrl, bucket, accessKey, secretKey, region) {
  return putObject(fs.readFileSync(filepath), contentTypeFor(filepath), objectKey, endpointUrl, bucket, accessKey, secretKey, region);
}

const objectKeyFor = (destPrefix, rel) => (destPrefix ? `${destPrefix}/${rel}` : rel);

// Uploads `files` (paths relative to backupRoot, '/'-separated) → { uploaded, failed } (lists of paths).
async function uploadTree(backupRoot, files, destPrefix, label, endpoint, bucket, accessKey, secretKey, region) {
  const uploaded = [];
  const failed = [];
  for (const rel of files) {
    const ok = await uploadFile(path.join(backupRoot, ...rel.split('/')), objectKeyFor(destPrefix, rel),
      endpoint, bucket, accessKey, secretKey, region);
    (ok ? uploaded : failed).push(rel);
  }
  return { uploaded, failed };
}

const xmlDecode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => (
  e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'"
    : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))));

// One ListObjectsV2 page → { items: [{key, size}], next: continuation token or null }.
function parseListObjects(xml) {
  const items = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
    key: xmlDecode((/<Key>([\s\S]*?)<\/Key>/.exec(m[1]) || [])[1] || ''),
    size: Number((/<Size>(\d+)<\/Size>/.exec(m[1]) || [])[1]),
  }));
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { items, next: truncated && token ? xmlDecode(token[1]) : null };
}

// Every object under `prefix/` → Map(key → size), or null (with the HTTP code
// logged) when the keys may not list the bucket.
async function listPrefix(prefix, endpoint, bucket, accessKey, secretKey, region) {
  const found = new Map();
  let token = null;
  for (let page = 0; page < 10000; page++) {
    let url = `${endpoint}/${s3Path(bucket)}?list-type=2&prefix=${uriEncode(`${prefix}/`)}`;
    if (token) url += `&continuation-token=${uriEncode(token)}`;
    let code = '000';
    let body = '';
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
      try {
        const r = await s3Request({ method: 'GET', url, region, accessKey, secretKey });
        code = String(r.status);
        body = await r.text();
      } catch { code = '000'; }
      if (!transientS3(code)) break;
      if (attempt < UPLOAD_ATTEMPTS) await sleep(attempt * 2000);
    }
    if (code !== '200') {
      logWarn(`  Could not list ${bucket}/${prefix}/ to verify the upload: [${code}] ${s3ErrorText(code, body)}`);
      return null;
    }
    const { items, next } = parseListObjects(body);
    for (const it of items) found.set(it.key, it.size);
    if (!next) return found;
    token = next;
  }
  return found;
}

// Uploads one backup to one destination: the .tf files, then a check that the
// bucket holds exactly those keys (and sizes), then — LAST — a completion
// manifest listing exactly the files uploaded to this prefix. Its presence
// means the backup under that prefix is complete.
// → list of relative paths that failed (empty = success).
async function uploadBackup(backupRoot, manifest, destPrefix, label, endpoint, bucket, accessKey, secretKey, region) {
  const entries = manifest.files.filter((f) => isUploadable(f.path));
  const files = entries.map((f) => f.path);
  logInfo(`  Files to upload to ${label}: ${files.length} .tf file(s) — ${manifest.files.length - files.length} other file(s) stay local`);
  if (!files.length) logWarn(`  No .tf files in ${backupRoot} — only ${MANIFEST_NAME} goes to ${label}`);
  const { uploaded, failed } = await uploadTree(backupRoot, files, destPrefix, label, endpoint, bucket, accessKey, secretKey, region);
  logInfo(`  ${label} upload done: ${uploaded.length} ok, ${failed.length} failed`);
  if (failed.length) return failed;

  const listed = await listPrefix(destPrefix, endpoint, bucket, accessKey, secretKey, region);
  if (listed) {
    const missing = entries.filter((f) => listed.get(objectKeyFor(destPrefix, f.path)) !== f.bytes).map((f) => f.path);
    if (missing.length) {
      logError(`  ${label}: ${missing.length} uploaded file(s) missing or the wrong size in the bucket listing`);
      return missing;
    }
    logOk(`  ${label}: bucket listing matches all ${files.length} file(s)`);
  } else {
    // Keys without list permission: every PUT above returned 200 for every file.
    logWarn(`  ${label}: verified by upload count only (${uploaded.length}/${files.length} PUTs returned 200)`);
    if (uploaded.length !== files.length) return files.filter((f) => !uploaded.includes(f));
  }

  const remote = { version: 1, createdAt: manifest.createdAt, files: entries };
  if (!(await putObject(Buffer.from(`${JSON.stringify(remote, null, 2)}\n`), 'application/json',
    objectKeyFor(destPrefix, MANIFEST_NAME), endpoint, bucket, accessKey, secretKey, region))) return [MANIFEST_NAME];
  return [];
}

// → list of relative paths that failed (empty = success).
async function r2Upload(backupRoot, manifest) {
  const destPrefix = `${R2_PREFIX ? `${R2_PREFIX}/` : ''}${path.basename(backupRoot)}`;
  let failed = ['(upload did not run)'];
  try {
    await r2Unlock();
    logSection(`R2: uploading backup to ${R2_BUCKET_NAME}/${destPrefix}`);
    logInfo(`  Source  : ${backupRoot}/`);
    logInfo(`  Dest    : ${R2_BUCKET_NAME}/${destPrefix}/`);
    logInfo(`  Endpoint: ${R2_ENDPOINT}`);
    logInfo(`  Files   : ${manifest.files.filter((f) => isUploadable(f.path)).length} (.tf only) + ${MANIFEST_NAME}`);

    failed = await uploadBackup(backupRoot, manifest, destPrefix, 'R2', R2_ENDPOINT, R2_BUCKET_NAME,
      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, 'auto');
    if (failed.length === 0) logOk(`  R2 upload complete → ${R2_BUCKET_NAME}/${destPrefix}/`);
    else logError(`  R2 upload had failures — local backup intact at: ${backupRoot}`);
  } finally {
    // Re-lock even when the upload fails part-way; a failed re-lock fails the run.
    if (!(await r2RestoreLock())) {
      logError(`R2 bucket '${R2_BUCKET_NAME}' lock rules could NOT be restored — the run will exit non-zero`);
    }
  }
  return failed;
}

// HEAD against us-east-1 and read the x-amz-bucket-region response header.
// Falls back to us-east-1 on failure. Result is stored in AWS_REGION.
async function awsDetectRegion() {
  if (AWS_REGION) {
    logInfo(`  AWS region (config): ${AWS_REGION}`);
    return;
  }
  logInfo(`  Auto-detecting AWS bucket region for: ${AWS_S3_BUCKET} …`);
  try {
    const r = await s3Request({
      method: 'HEAD',
      url: `https://s3.us-east-1.amazonaws.com/${s3Path(AWS_S3_BUCKET)}`,
      region: 'us-east-1',
      accessKey: AWS_ACCESS_KEY_ID,
      secretKey: AWS_SECRET_ACCESS_KEY,
    });
    AWS_REGION = (r.headers.get('x-amz-bucket-region') || '').trim();
  } catch { AWS_REGION = ''; }
  if (!AWS_REGION) {
    logWarn('  Region detection failed — defaulting to us-east-1');
    AWS_REGION = 'us-east-1';
  }
  logInfo(`  AWS region (detected): ${AWS_REGION}`);
}

// → list of relative paths that failed (empty = success).
async function awsUpload(backupRoot, manifest) {
  const destPrefix = path.basename(backupRoot);
  await awsDetectRegion();

  logSection(`AWS S3: uploading backup to s3://${AWS_S3_BUCKET}/${destPrefix}`);
  logInfo(`  Source  : ${backupRoot}/`);
  logInfo(`  Dest    : s3://${AWS_S3_BUCKET}/${destPrefix}/`);
  logInfo(`  Region  : ${AWS_REGION}`);
  logInfo(`  Files   : ${manifest.files.filter((f) => isUploadable(f.path)).length} (.tf only) + ${MANIFEST_NAME}`);

  const failed = await uploadBackup(backupRoot, manifest, destPrefix, 'AWS S3', `https://s3.${AWS_REGION}.amazonaws.com`,
    AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION);
  if (failed.length === 0) logOk(`  AWS S3 upload complete → s3://${AWS_S3_BUCKET}/${destPrefix}/`);
  else logError(`  AWS S3 upload had failures — local backup intact at: ${backupRoot}`);
  return failed;
}

// =============================================================================
// COMBINED UPLOAD ORCHESTRATOR
// Runs both destinations in sequence; a failure in one does not abort the
// other, but any failed file (or a failed R2 re-lock) fails the run.
// → true when every enabled destination got every file and its manifest.
// =============================================================================
async function runUploads(backupRoot, manifest) {
  const problems = [];
  if (R2_SKIP_UPLOAD !== 'true') {
    const failed = await r2Upload(backupRoot, manifest);
    if (failed.length) problems.push(['R2', failed]);
    if (!(await r2RestoreLock())) problems.push(['R2', [`(bucket '${R2_BUCKET_NAME}' lock rules not restored)`]]);
  } else {
    logInfo('R2_SKIP_UPLOAD=true — skipping R2 upload');
  }
  if (AWS_SKIP_UPLOAD !== 'true') {
    const failed = await awsUpload(backupRoot, manifest);
    if (failed.length) problems.push(['AWS S3', failed]);
  } else {
    logInfo('AWS_SKIP_UPLOAD=true — skipping AWS S3 upload');
  }
  if (!problems.length) return true;
  logSection('Upload FAILED');
  for (const [label, failed] of problems) {
    logError(`${label}: ${failed.length} file(s) not uploaded / not verified:`);
    for (const f of failed.slice(0, 50)) logError(`  ${f}`);
    if (failed.length > 50) logError(`  … and ${failed.length - 50} more`);
  }
  logError(`${MANIFEST_NAME} was not uploaded where files failed — that remote copy is INCOMPLETE`);
  return false;
}
// ==== UPLOADS END ============================================================

// =============================================================================
// MAIN
// =============================================================================
// Completion manifest: written last into the backup folder (listing every file
// in it), and uploaded last to each destination prefix (listing exactly the
// files uploaded there) once those are verified. Restore treats a backup
// without it (or with a file that does not match it) as incomplete — keep the
// name and shape stable.
//   { version: 1, createdAt, files: [{ path, bytes, sha256 }] }   (paths '/'-separated, relative to the backup folder)
const MANIFEST_NAME = '_backup-complete.json';

function writeCompletionManifest(root) {
  const files = walk(root)
    .map((p) => path.relative(root, p).split(path.sep).join('/'))
    .filter((rel) => rel !== MANIFEST_NAME)
    .sort()
    .map((rel) => {
      const data = fs.readFileSync(path.join(root, ...rel.split('/')));
      return { path: rel, bytes: data.length, sha256: sha256Hex(data) };
    });
  const manifest = { version: 1, createdAt: new Date().toISOString(), files };
  fs.writeFileSync(path.join(root, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  logOk(`Completion manifest: ${MANIFEST_NAME} (${files.length} file(s))`);
  return manifest;
}

// Everything that did NOT make it into the backup, in one place:
// <backup_root>/_backup_summary.txt. A backup with a non-empty summary is still
// usable, but these are the gaps a restore would hit.
function writeIntegritySummary(root) {
  const summary = path.join(root, '_backup_summary.txt');
  const files = walk(root);
  const rel = (p) => p.slice(root.length + 1);
  const errorFiles = files.filter((f) => f.endsWith('.error')).map(rel).sort();
  const brokenFiles = files.filter((f) => f.endsWith('.broken')).map(rel).sort();
  const failureFiles = files.filter((f) => path.basename(f) === '_generate_failures.txt').sort();
  const apiErrs = apiErrors.length;
  const genFail = failureFiles.reduce((n, f) => n + (fs.readFileSync(f, 'utf8').match(/\n/g) || []).length, 0);

  const codeCounts = new Map();
  for (const l of apiErrors) {
    const c = l.split('\t')[0];
    codeCounts.set(c, (codeCounts.get(c) || 0) + 1);
  }
  const breakdown = [...codeCounts]
    .map(([c, n]) => `${String(n).padStart(7)} ${c}`)
    .sort((a, b) => Number(b.slice(0, 7)) - Number(a.slice(0, 7)) || (a < b ? 1 : a > b ? -1 : 0));
  const failureLines = [];
  for (const f of failureFiles) {
    const content = fs.readFileSync(f, 'utf8');
    for (const line of content.replace(/\n$/, '').split('\n')) failureLines.push(`${rel(f)}: ${line}`);
  }

  const lines = [
    `Backup integrity summary — ${dateU()}`,
    '',
    `Failed API requests          : ${apiErrs}  (_api_errors.tsv)`,
    `JSON dumps NOT saved (*.error): ${errorFiles.length}`,
    `Files with quarantined blocks : ${brokenFiles.length}  (*.broken — failed terraform validate)`,
    `cf-terraforming failures      : ${genFail}  (*/_generate_failures.txt)`,
    ...(IMPORT_MODE ? [`Import reports                : ${files.filter((f) => path.basename(f) === '_import_report.txt').length}  (*/_import_report.txt)`] : []),
    '',
    '── HTTP status breakdown ──',
    ...breakdown,
    '',
    '── cf-terraforming failures ──',
    ...failureLines,
    '',
    '── Missing JSON dumps ──',
    ...errorFiles,
    '',
    '── Quarantined HCL ──',
    ...brokenFiles,
  ];
  fs.writeFileSync(summary, `${lines.join('\n')}\n`);

  logSection('Integrity summary');
  logInfo(`Failed API requests: ${apiErrs} | JSON not saved: ${errorFiles.length} | quarantined HCL files: ${brokenFiles.length} | cf-terraforming failures: ${genFail}`);
  if (apiErrs > 0 || errorFiles.length > 0 || brokenFiles.length > 0 || genFail > 0) {
    logWarn(`Backup has gaps — review ${summary}`);
  } else {
    logOk('No gaps detected');
  }
}

function usage(stream = process.stdout) {
  stream.write(`Usage: backup.js [options] [ZONE_ID ...]

  No zone IDs     Back up every zone on the account plus account-level
                  resources (lists, Access, tunnels, Workers, IAM, …).
  ZONE_ID ...     Back up only these zones (space- or comma-separated).
                  Account-level resources are skipped unless --with-account.

Options:
  -z, --zone ID       Add a zone ID (repeatable; same as a positional ID)
  -a, --with-account  With zone IDs: also back up account-level resources
      --import        Generate AND write imports.tf (Terraform import blocks)
                      in every Terraform folder, checked with a read-only plan
      --generate-only Generate only — no import blocks (the default)
      --mode MODE     Same as the two above: MODE is generate or import
  -h, --help          Show this help

Zone IDs can also come from ZONE_IDS in .env; command-line IDs override it.
Set BACKUP_ACCOUNT=true in .env to always include account-level resources.
Set BACKUP_MODE=import in .env to make import mode the default.
`);
}

// Sets ZONE_IDS (space-separated, validated) and IMPORT_MODE; returns INCLUDE_ACCOUNT.
function parseArgs(argv) {
  const cliIds = [];
  let withAccount = false;
  let mode = BACKUP_MODE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a === '-a' || a === '--with-account') withAccount = true;
    else if (a === '--import') mode = 'import';
    else if (a === '--generate-only') mode = 'generate';
    else if (a === '--mode') {
      if (i + 1 >= argv.length) { process.stderr.write(`error: ${a} needs generate or import\n`); process.exit(2); }
      mode = argv[++i];
    } else if (a.startsWith('--mode=')) mode = a.slice('--mode='.length);
    else if (a === '-z' || a === '--zone') {
      if (i + 1 >= argv.length) { process.stderr.write(`error: ${a} needs a zone ID\n`); process.exit(2); }
      cliIds.push(argv[++i]);
    } else if (a.startsWith('--zone=')) cliIds.push(a.slice('--zone='.length));
    else if (a.startsWith('-')) { process.stderr.write(`error: unknown option ${a}\n`); usage(process.stderr); process.exit(2); }
    else cliIds.push(a);
  }

  if (cliIds.length) ZONE_IDS = cliIds.join(' ');
  // Normalise: commas → spaces, lowercase, drop duplicates (keep order).
  ZONE_IDS = [...new Set(ZONE_IDS.replace(/,/g, ' ').toLowerCase().split(/\s+/).filter(Boolean))].join(' ');

  let bad = false;
  for (const id of ZONE_IDS.split(' ').filter(Boolean)) {
    if (!/^[0-9a-f]{32}$/.test(id)) {
      process.stderr.write(`error: '${id}' is not a zone ID (expected 32 hex characters)\n`);
      bad = true;
    }
  }
  if (bad) process.exit(2);

  if (mode !== 'generate' && mode !== 'import') {
    process.stderr.write(`error: mode must be generate or import (got '${mode}')\n`);
    process.exit(2);
  }
  IMPORT_MODE = mode === 'import';

  let include;
  if (BACKUP_ACCOUNT === 'true') include = true;
  else if (BACKUP_ACCOUNT === 'false') include = false;
  else if (BACKUP_ACCOUNT === 'auto') include = !ZONE_IDS || withAccount;
  else {
    process.stderr.write(`error: BACKUP_ACCOUNT must be auto, true or false (got '${BACKUP_ACCOUNT}')\n`);
    process.exit(2);
  }
  return include || withAccount;
}

let BACKUP_ROOT = '';

async function main() {
  const INCLUDE_ACCOUNT = parseArgs(process.argv.slice(2));
  E.CLOUDFLARE_API_TOKEN = CF_API_TOKEN;

  const TIMESTAMP = stampU();

  // ── Logging: mirror everything to a logfile in addition to the console.
  // Must be set up before any other output so nothing is missed.
  const LOG_DIR = path.join(OUTPUT_DIR, 'logs');
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const LOG_FILE = path.join(LOG_DIR, `cf_backup_${TIMESTAMP}.log`);
  LOG_FD = fs.openSync(LOG_FILE, 'a');

  checkPrereqs();

  // Scratch space for the provider schema and temp files — outside the backup
  // tree, removed on exit.
  WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cf_backup_work.'));

  // One shared provider download for every directory instead of ~190 MB per
  // zone (respects a TF_PLUGIN_CACHE_DIR the caller already set).
  E.TF_PLUGIN_CACHE_DIR = E.TF_PLUGIN_CACHE_DIR || `${E.HOME || ''}/.terraform.d/plugin-cache`;
  fs.mkdirSync(E.TF_PLUGIN_CACHE_DIR, { recursive: true });

  // ── Account + token access preflight ───────────────────────────────────
  // GET /accounts/{id} needs Account Settings: Read; without it Cloudflare
  // answers 404 "Account not found" (code 1003), not 403. The account list
  // works with any permission on the account, so it tells a wrong account ID
  // apart from that missing permission.
  const acct = await cfApiProbe(`/accounts/${CF_ACCOUNT_ID}`);
  let ACCOUNT_NAME = jqAlt(() => jqGet(acct, ['result', 'name']), '') || '';
  let accountSettingsOk = true;
  if (!ACCOUNT_NAME) {
    accountSettingsOk = false;
    const list = await cfApiProbe('/accounts?per_page=50');
    const hit = jqIter(list && list.result).find((a) => isObj(a) && a.id === CF_ACCOUNT_ID);
    ACCOUNT_NAME = (hit && hit.name) || '';
    if (!ACCOUNT_NAME) {
      logError(`Account ${CF_ACCOUNT_ID} is not visible to this API token — check CF_ACCOUNT_ID, and that the token's`);
      logError('Account Resources include this account (My Profile > API Tokens > edit token)');
      exitNow(1);
    }
    logWarn(`Token can see account '${ACCOUNT_NAME}' but lacks Account Settings: Read (GET /accounts/{id} → 404)`);
    logWarn('  continuing — cloudflare_account and account_details.json will be missing from this backup');
  }

  // A token that reads nothing would produce an empty backup that looks like a
  // successful one: probe a few read endpoints first.
  let visibleZones = '';
  let readable = 0;
  if (!ZONE_IDS) {
    const z = await cfApiProbe(`/zones?account.id=${CF_ACCOUNT_ID}&per_page=5`);
    visibleZones = String(jqAlt(() => jqGet(z, ['result_info', 'total_count']), null) ?? 0);
  }
  if (INCLUDE_ACCOUNT) {
    for (const probe of ['rulesets', 'rules/lists', 'access/apps', 'workers/scripts', 'cfd_tunnel', 'members']) {
      if (await cfApiProbe(`/accounts/${CF_ACCOUNT_ID}/${probe}`)) readable++;
    }
  }
  if (visibleZones === '0' && (!INCLUDE_ACCOUNT || readable === 0)) {
    logError(`This API token can read nothing in account '${ACCOUNT_NAME}': it sees 0 zones${INCLUDE_ACCOUNT ? ' and gets 403 on every account resource probed' : ''}.`);
    logError('Create a token from the "Read all resources" template (My Profile > API Tokens > Create Token),');
    logError(`with Account Resources = ${ACCOUNT_NAME} and Zone Resources = All zones from that account,`);
    logError('and set it as CF_API_TOKEN in .env.');
    exitNow(1);
  }
  if (visibleZones === '0') {
    logWarn(`Token sees 0 zones in '${ACCOUNT_NAME}' — no zone backups (needs Zone: Read on All zones, if the account has zones)`);
  }
  if (INCLUDE_ACCOUNT && readable < 6) {
    logWarn(`Token can read ${readable}/6 account resource types probed — expect 403 gaps (see _backup_summary.txt)`);
  }
  const ACCOUNT_NAME_SAFE = safeName(String(ACCOUNT_NAME), /[^a-zA-Z0-9_-]/g);

  // Zone-scoped runs get a "_partial" suffix so they're never mistaken for a
  // full account backup when browsing OUTPUT_DIR or the upload bucket.
  BACKUP_ROOT = path.join(OUTPUT_DIR, `${ACCOUNT_NAME_SAFE}_${TIMESTAMP}${ZONE_IDS ? '_partial' : ''}`);
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  API_ERROR_LOG = path.join(BACKUP_ROOT, '_api_errors.tsv');
  writeApiErrorLog();
  if (!accountSettingsOk) recordApiError('404', `/accounts/${CF_ACCOUNT_ID}`, 'Account not found — token lacks Account Settings: Read');

  // ── Discover every zone to back up ─────────────────────────────────────────
  const zones = await discoverZones();

  logSection('Cloudflare Terraform Backup  (provider v5, multi-zone)');
  logInfo(`Account  : ${ACCOUNT_NAME} (${CF_ACCOUNT_ID})`);
  logInfo(`Output   : ${BACKUP_ROOT}`);
  logInfo(`Zones    : ${zones.length} zone(s) selected${ZONE_IDS ? ' (explicit zone IDs)' : ' (all zones)'}`);
  logInfo(`Account  : account-level resources ${INCLUDE_ACCOUNT ? 'INCLUDED' : 'skipped (pass --with-account or set BACKUP_ACCOUNT=true in .env)'}`);
  logInfo(`Mode     : ${IMPORT_MODE ? 'import — generate + imports.tf (verified with a read-only plan)' : 'generate only'}`);
  logInfo(`Logfile  : ${LOG_FILE}`);
  logInfo(`Started  : ${dateU()}`);

  // ── Account-level resources: run exactly once ──────────────────────────────
  if (INCLUDE_ACCOUNT) {
    await backupAccountTerraform(BACKUP_ROOT);
    await backupLists(BACKUP_ROOT);
    await backupIpResourcesAccount(BACKUP_ROOT);
    await backupApiAccount(BACKUP_ROOT);
  }

  // ── Per-zone resources: loop over every discovered zone ────────────────────
  let zoneNum = 0;
  for (const [zoneId, zoneName] of zones) {
    if (!zoneId) continue;
    // The id must look like a real Cloudflare zone id and the name must be
    // present, or every zone-scoped step would write into the backup root.
    if (!/^[0-9a-f]{32}$/.test(zoneId) || !zoneName) {
      logWarn(`Skipping malformed zone row: id='${zoneId}' name='${zoneName}'`);
      continue;
    }
    zoneNum++;
    logSection(`[Zone ${zoneNum}/${zones.length}] ${zoneName} (${zoneId})`);

    await backupZoneTerraform(BACKUP_ROOT, zoneName, zoneId);
    await backupIpResourcesZone(BACKUP_ROOT, zoneName, zoneId);
    await backupApiZone(BACKUP_ROOT, zoneName, zoneId);
  }

  // .terraform/ holds the provider binary (~190 MB per directory) and is
  // recreated by `terraform init`; .terraform.lock.hcl stays to pin the
  // provider version. Removing it keeps backups (and uploads) to the data.
  for (const d of walk(BACKUP_ROOT, { dirs: true }).filter((p) => path.basename(p) === '.terraform')) {
    fs.rmSync(d, { recursive: true, force: true });
  }

  writeIntegritySummary(BACKUP_ROOT);

  // Nothing may change in the backup folder after the manifest is hashed: API
  // errors from here on (e.g. the R2 lock calls) are logged, not recorded.
  API_ERROR_LOG = null;
  const manifest = writeCompletionManifest(BACKUP_ROOT);

  if (!(await runUploads(BACKUP_ROOT, manifest))) {
    logError(`Backup written locally to ${BACKUP_ROOT}, but the upload FAILED — see above`);
    exitNow(1);
  }

  logSection('Backup complete');
  out(GREEN);
  out([
    `  ${BACKUP_ROOT}/`,
    '  ├── account/                          (everything account-scoped)',
    '  │   ├── provider.tf',
    '  │   ├── cloudflare_account.tf',
    '  │   ├── cloudflare_<account-scoped resource>.tf',
    '  │   ├── lists/',
    '  │   │   ├── cloudflare_list.tf',
    '  │   │   └── data/<list>_<kind>.json',
    '  │   ├── ip_resources/',
    '  │   │   ├── ip_access_rules_account.json',
    '  │   │   ├── ip_access_rules_zone_<zone1.com>.json',
    '  │   │   ├── byoip_prefixes.json',
    '  │   │   └── address_maps.json',
    '  │   └── api_backup/',
    '  │       ├── account_details.json, iam_*, r2_buckets.json, …',
    '  │       ├── zone_<zone1.com>/',
    '  │       │   └── zone_settings_raw.json, dns_settings.json, …',
    '  │       └── zone_<zone2.com>/',
    '  │           └── …',
    '  ├── <zone1.com>/                       (Terraform HCL for this zone)',
    '  │   ├── provider.tf',
    '  │   ├── cloudflare_dns_record.tf',
    '  │   └── cloudflare_<resource>.tf',
    '  ├── <zone2.com>/',
    '  │   └── …',
    '  └── <zoneN.com>/',
    '      └── …',
  ].join('\n'));
  out(NC);

  if (R2_SKIP_UPLOAD !== 'true') logOk(`R2    : ${R2_BUCKET_NAME}${R2_PREFIX ? `/${R2_PREFIX}` : ''}/${path.basename(BACKUP_ROOT)}/`);
  if (AWS_SKIP_UPLOAD !== 'true') logOk(`AWS S3: s3://${AWS_S3_BUCKET}/${path.basename(BACKUP_ROOT)}/`);
  logOk(`Zones backed up: ${zoneNum}`);
  logOk(`Finished: ${dateU()}`);
  logOk(`Full log : ${LOG_FILE}`);
}

// Scratch dir is removed however the run ends.
process.on('exit', () => {
  if (WORK_DIR) fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

if (require.main === module) {
  // Whatever the outcome, an unlocked R2 bucket gets its rules back before the
  // process exits (a no-op when nothing was unlocked or it already happened);
  // a failed restore turns any exit code into a failure.
  const exitAfterRelock = (code) => r2RestoreLock().then((ok) => {
    if (!ok && code === 0) logError('R2 bucket lock rules could not be restored — failing the run');
    process.exit(ok ? code : code || 1);
  }, () => process.exit(code || 1));
  main().then(() => exitAfterRelock(0), (err) => {
    if (err instanceof ExitRequest) return exitAfterRelock(err.exitCode);
    // Any unexpected failure kills the run mid-way and leaves a partial backup
    // that looks superficially fine — make that loud instead.
    const where = (err && err.stack ? err.stack.split('\n')[1] || '' : '').trim();
    logError(`ABORTED: ${err && err.message ? err.message : err} ${where}`);
    logError(`Backup is INCOMPLETE — do not treat ${BACKUP_ROOT || 'the output directory'} as a full backup`);
    return exitAfterRelock(1);
  });
} else {
  // Exposed for tests only.
  module.exports = {
    schemaFilter, toHcl, hclString, hclKey, resourceBlocks, stripNonConfigAttrs, findAttrSpan, splitListItems,
    parseMultipart, sigV4Authorization, patchSchemaGaps, quarantineBlocks, parseEnvValue, globToRegex,
    _setSchemaFile: (f) => { PROVIDER_SCHEMA_JSON = f; PROVIDER_SCHEMA = null; },
    _uploads: {
      r2Unlock, r2RestoreLock, r2Upload, awsUpload, runUploads, uploadFile, parseListObjects, writeCompletionManifest,
      MANIFEST_NAME, r2Lock,
    },
  };
}
