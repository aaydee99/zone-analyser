import 'server-only';
import crypto from 'node:crypto';
import { cached, tag } from './cache';
import type { Credential } from './vault';
import { BUCKET_PATTERN, R2_ENDPOINT_PATTERN, STORAGE_LABEL, storageFields, type TestResult } from './kinds';
import { compactNum } from './num';

const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page: number; total_pages: number; total_count: number };
}

async function cf<T>(token: string, p: string): Promise<{ status: number; body: CfEnvelope<T> | null }> {
  const res = await fetch(`${CF_API}${p}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
    cache: 'no-store',
  });
  let body: CfEnvelope<T> | null = null;
  try { body = (await res.json()) as CfEnvelope<T>; } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const cfError = (b: CfEnvelope<unknown> | null, status: number) => b?.errors?.[0]?.message ?? `HTTP ${status}`;

export interface Zone { id: string; name: string; status: string; plan: string; paused: boolean; accountId: string; accountName: string }

/** A Cloudflare account the credential works with. */
export interface CfAccount { id: string; name: string }

/** The credential's Cloudflare accounts: its account ID, or (left empty) every account the token can access. Kept for five minutes. */
export function tokenAccounts(c: Credential): Promise<CfAccount[]> {
  const fixed = c.fields.accountId?.trim();
  if (fixed) return Promise.resolve([{ id: fixed, name: '' }]);
  return cached(`cf:token-accounts:${tag(c.fields.apiToken)}`, 5 * 60_000, async () => {
    const out: CfAccount[] = [];
    let refused = '';
    for (let page = 1; page <= 100; page++) {
      const { status, body } = await cf<{ id: string; name: string }[]>(c.fields.apiToken, `/accounts?per_page=50&page=${page}`);
      if (!body?.success) { refused = cfError(body, status); break; }
      for (const a of body.result) out.push({ id: a.id, name: a.name });
      if (!body.result_info || page >= body.result_info.total_pages) break;
    }
    if (out.length) return out;
    // A token with zone permissions only lists no account: take the accounts of the zones it can see.
    const fromZones = new Map<string, string>();
    for (const z of await readZones(c).catch(() => [])) if (z.accountId) fromZones.set(z.accountId, z.accountName);
    if (fromZones.size) return [...fromZones].map(([id, name]) => ({ id, name }));
    throw new Error(`This API token can access no Cloudflare account or zone${refused ? ` (Cloudflare: ${refused})` : ''}. Give it access (for example "Read all resources"), or enter the account ID`);
  });
}

/** The account's zones (or, with no account ID, every zone the token can see) for the backup and restore pickers, kept for two minutes. */
export function listZones(c: Credential): Promise<Zone[]> {
  return cached(`cf:picker-zones:${c.fields.accountId || 'all'}:${tag(c.fields.apiToken)}`, 2 * 60_000, () => readZones(c));
}

async function readZones(c: Credential): Promise<Zone[]> {
  const { apiToken, accountId } = c.fields;
  const zones: Zone[] = [];
  for (let page = 1; page <= 200; page++) {
    const { status, body } = await cf<{ id: string; name: string; status: string; paused: boolean; plan?: { name: string }; account?: { id: string; name: string } }[]>(
      apiToken, `/zones?${accountId ? `account.id=${accountId}&` : ''}per_page=50&page=${page}&order=name`);
    if (!body?.success) throw new Error(`Cloudflare: ${cfError(body, status)}`);
    for (const z of body.result) {
      zones.push({ id: z.id, name: z.name, status: z.status, paused: z.paused, plan: z.plan?.name ?? '', accountId: z.account?.id ?? accountId ?? '', accountName: z.account?.name ?? '' });
    }
    if (!body.result_info || page >= body.result_info.total_pages) break;
  }
  return zones;
}

async function testCloudflare(c: Credential): Promise<string> {
  const { apiToken, accountId } = c.fields;
  if (!accountId) {
    // No account ID: the token is checked by what it can reach.
    const v = await cf<{ status: string }>(apiToken, '/user/tokens/verify');
    if (v.body?.success && v.body.result.status !== 'active') throw new Error(`Token status is "${v.body.result.status}"`);
    const accounts = await tokenAccounts(c);
    const zones = await cf<unknown[]>(apiToken, '/zones?per_page=1');
    const count = zones.body?.result_info?.total_count ?? 0;
    const names = accounts.map((a) => `"${a.name || a.id}"`);
    return `Token active · ${compactNum(accounts.length)} account${accounts.length === 1 ? '' : 's'} (${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}) · ${compactNum(count)} zone${count === 1 ? '' : 's'} visible`;
  }
  // User-owned tokens verify at /user/tokens/verify, account-owned ones under the account.
  let v = await cf<{ status: string }>(apiToken, '/user/tokens/verify');
  if (!v.body?.success) v = await cf<{ status: string }>(apiToken, `/accounts/${accountId}/tokens/verify`);
  if (!v.body?.success) throw new Error(`Token rejected: ${cfError(v.body, v.status)}`);
  if (v.body.result.status !== 'active') throw new Error(`Token status is "${v.body.result.status}"`);

  const acct = await cf<{ name: string }>(apiToken, `/accounts/${accountId}`);
  let name = acct.body?.success ? acct.body.result.name : '';
  if (!name) {
    const list = await cf<{ id: string; name: string }[]>(apiToken, '/accounts?per_page=50');
    name = list.body?.result?.find((a) => a.id === accountId)?.name ?? '';
    if (!name) throw new Error('Token is valid but cannot see this account ID');
  }
  const zones = await cf<unknown[]>(apiToken, `/zones?account.id=${accountId}&per_page=1`);
  const count = zones.body?.result_info?.total_count ?? 0;
  return `Token active · account "${name}" · ${compactNum(count)} zone${count === 1 ? '' : 's'} visible`;
}

// Minimal SigV4 for a HEAD Bucket request.
function sha256(data: string) { return crypto.createHash('sha256').update(data).digest('hex'); }
function hmac(key: crypto.BinaryLike, data: string) { return crypto.createHmac('sha256', key).update(data).digest(); }

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves ! ' ( ) * as they are). */
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A SigV4-signed S3 request with an empty body. */
export async function s3Request(method: 'HEAD' | 'GET', url: URL, region: string, accessKey: string, secretKey: string) {
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256('');
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  // The query is sent exactly as signed (URLSearchParams would write spaces as "+" and leave "*").
  const query = [...url.searchParams].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join('&');
  url = new URL(url);
  url.search = query ? `?${query}` : '';
  const canonical = [method, url.pathname, query, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let k = hmac(`AWS4${secretKey}`, dateStamp);
  for (const part of [region, 's3', 'aws4_request']) k = hmac(k, part);
  const signature = crypto.createHmac('sha256', k).update(toSign).digest('hex');
  return fetch(url, {
    method,
    headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
    signal: AbortSignal.timeout(20_000),
    cache: 'no-store',
  });
}

async function headBucket(endpoint: string, bucket: string, region: string, accessKey: string, secretKey: string) {
  return s3Request('HEAD', new URL(`${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}`), region, accessKey, secretKey);
}

/**
 * Buckets these keys can list (S3 ListBuckets). R2 only accepts its own endpoint format
 * and AWS uses the fixed global endpoint, so stored keys are never sent anywhere else.
 */
export async function listBuckets(kind: 'r2' | 'aws', fields: Record<string, string>): Promise<string[]> {
  const { accessKeyId, secretAccessKey } = fields;
  if (!accessKeyId || !secretAccessKey) throw new Error('Enter the access key ID and secret first');
  let url: URL;
  let region: string;
  if (kind === 'r2') {
    if (!new RegExp(R2_ENDPOINT_PATTERN).test(fields.endpoint ?? '')) throw new Error('Enter a valid R2 endpoint first');
    url = new URL(`${fields.endpoint.replace(/\/+$/, '')}/`);
    region = 'auto';
  } else {
    url = new URL('https://s3.us-east-1.amazonaws.com/');
    region = 'us-east-1';
  }
  let res: Response;
  try { res = await s3Request('GET', url, region, accessKeyId, secretAccessKey); } catch { throw new Error('Network error — could not reach the endpoint'); }
  if (res.status === 403) {
    const why = s3Reason(kind, 403, await res.text().catch(() => ''));
    // A key limited to certain buckets is valid but may not list all buckets: that is not an error in the key.
    if (/AccessDenied/.test(why.code)) throw new Error(`These keys may not list buckets (403) — normal for an ${kind === 'r2' ? 'R2 token scoped to specific buckets' : 'IAM user without s3:ListAllMyBuckets'}. Type the bucket names instead.`);
    throw new Error(`Listing buckets failed: ${why.text}`);
  }
  if (!res.ok) throw new Error(`Listing buckets failed: ${s3Reason(kind, res.status, await res.text().catch(() => '')).text}`);
  const xml = await res.text();
  const names = [...xml.matchAll(/<Bucket>[\s\S]*?<Name>([^<]+)<\/Name>[\s\S]*?<\/Bucket>/g)].map((m) => m[1].trim());
  const re = new RegExp(BUCKET_PATTERN);
  return [...new Set(names.filter((n) => re.test(n)))].sort();
}

/**
 * Why S3 / R2 refused a request, from its XML error <Code> (a 403 alone can mean a wrong secret,
 * an unknown key, a skewed clock or a missing permission — each needs a different fix).
 */
export function s3Reason(kind: 'r2' | 'aws', status: number, body: string, bucket = ''): { code: string; text: string } {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? '';
  const on = bucket ? ` "${bucket}"` : '';
  const r2 = kind === 'r2';
  const text = ({
    SignatureDoesNotMatch: `the secret access key does not match the access key ID${r2 ? ' — use the S3 "Secret Access Key" shown when the R2 token was created, not the token value' : ''}`,
    InvalidAccessKeyId: `the access key ID is not recognised${r2 ? ' — use the S3 "Access Key ID" of an R2 API token, for the account in the endpoint' : ''}`,
    InvalidArgument: 'the request was rejected as invalid — check the access key ID',
    RequestTimeTooSkewed: "this computer's clock is too far off — sync its time",
    AccessDenied: r2
      ? `these keys are valid but may not access${on || ' this bucket'} — give the R2 token "Object Read & Write" and include this bucket in its scope`
      : `these keys are valid but may not access${on || ' this bucket'} — the IAM policy needs s3:ListBucket, s3:GetObject and s3:PutObject on it`,
    NoSuchBucket: `bucket${on} does not exist${r2 ? ' at this endpoint — EU-jurisdiction buckets need the ….eu.r2.cloudflarestorage.com endpoint' : ''}`,
    PermanentRedirect: `bucket${on} is in another region — set the region`,
    AuthorizationHeaderMalformed: 'the region does not match the bucket — set the right region',
  } as Record<string, string>)[code];
  return { code, text: `${text ?? (status === 404 ? `bucket${on} not found` : status === 301 ? `bucket${on} is in a different region — set the region` : `HTTP ${status}`)}${code ? ` (${code})` : ` (${status})`}` };
}

function describeS3(status: number, bucket: string, extra = '') {
  if (status === 200) return `Bucket "${bucket}" reachable with these keys${extra}`;
  if (status === 403) throw new Error(`Access denied to "${bucket}" (403) — check keys and bucket permissions`);
  if (status === 404) throw new Error(`Bucket "${bucket}" not found (404)`);
  if (status === 301) throw new Error(`Bucket "${bucket}" is in a different region (301) — set the region`);
  throw new Error(`Unexpected HTTP ${status} from bucket "${bucket}"`);
}

/**
 * R2: lists one object of the default bucket. That is what backups and restores need, and it
 * works with an R2 token scoped to "Object Read & Write" on chosen buckets — HeadBucket needs
 * a bucket-level permission such tokens do not have, so it reported valid keys as denied.
 */
async function testR2(c: Credential) {
  const { accessKeyId, secretAccessKey, endpoint, bucket } = c.fields;
  if (!new RegExp(R2_ENDPOINT_PATTERN).test(endpoint ?? '')) throw new Error('The R2 endpoint is not valid');
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${rfc3986(bucket)}`);
  url.searchParams.set('list-type', '2');
  url.searchParams.set('max-keys', '1');
  const res = await s3Request('GET', url, 'auto', accessKeyId, secretAccessKey);
  if (res.ok) { await assertPrivate(url, bucket); return `Bucket "${bucket}" readable with these keys · not public`; }
  throw new Error(`R2 bucket "${bucket}": ${s3Reason('r2', res.status, await res.text().catch(() => ''), bucket).text}`);
}

async function testAws(c: Credential) {
  const { accessKeyId, secretAccessKey, bucket } = c.fields;
  let region = c.fields.region || '';
  if (!region) {
    const probe = await fetch(`https://${bucket}.s3.amazonaws.com`, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    region = probe.headers.get('x-amz-bucket-region') || 'us-east-1';
  }
  const res = await headBucket(`https://s3.${region}.amazonaws.com`, bucket, region, accessKeyId, secretAccessKey);
  const ok = describeS3(res.status, bucket, ` · region ${region}`);
  // S3's own verdict (bucket policy / ACLs), then an anonymous listing attempt.
  const status = await s3Request('GET', new URL(`https://s3.${region}.amazonaws.com/${rfc3986(bucket)}?policyStatus`), region, accessKeyId, secretAccessKey).catch(() => null);
  if (status?.ok && /<IsPublic>\s*true\s*<\/IsPublic>/i.test(await status.text())) throw new Error(`Bucket "${bucket}" is PUBLIC (its bucket policy allows public access) — backups contain your configuration; make it private`);
  const list = new URL(`https://s3.${region}.amazonaws.com/${rfc3986(bucket)}`);
  list.searchParams.set('list-type', '2');
  list.searchParams.set('max-keys', '1');
  await assertPrivate(list, bucket);
  return `${ok} · not public`;
}

/**
 * Backups hold a whole account's configuration, so their bucket must not be public: an unsigned
 * (anonymous) listing has to be refused. (An R2 public r2.dev URL or custom domain is set on the
 * bucket in the dashboard and cannot be seen from the S3 API.)
 */
async function assertPrivate(listUrl: URL, bucket: string) {
  const anon = await fetch(listUrl, { signal: AbortSignal.timeout(15_000), cache: 'no-store' }).catch(() => null);
  if (anon?.ok) throw new Error(`Bucket "${bucket}" is PUBLIC — anyone can list it without keys. Backups contain your configuration; make the bucket private`);
}

export async function testCredential(c: Credential): Promise<TestResult> {
  const at = new Date().toISOString();
  try {
    if (c.kind !== 'cloudflare') {
      return { ok: true, message: c.kind === 'r2' ? await testR2(c) : await testAws(c), at };
    }
    // Account set: the Cloudflare token and each storage it has, each checked on its own so one
    // failing part does not hide the result of the others.
    const parts: { ok: boolean; text: string }[] = [];
    const part = async (label: string, run: () => Promise<string>) => {
      try { parts.push({ ok: true, text: `${label}: ${await run()}` }); } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        parts.push({ ok: false, text: `${label}: ${msg.includes('fetch failed') ? 'network error — could not reach the endpoint' : msg}` });
      }
    };
    await part('Cloudflare', () => testCloudflare(c));
    for (const g of ['r2', 'aws'] as const) {
      const fields = storageFields(c.fields, g);
      if (fields) await part(STORAGE_LABEL[g], () => (g === 'r2' ? testR2 : testAws)({ ...c, kind: g, fields }));
    }
    return { ok: parts.every((x) => x.ok), message: parts.map((x) => x.text).join(' · '), at };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: msg.includes('fetch failed') ? 'Network error — could not reach the endpoint' : msg, at };
  }
}
