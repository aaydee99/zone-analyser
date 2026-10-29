import 'server-only';
import { HttpError } from './http';
import { rfc3986, s3Reason, s3Request } from './providers';
import { approvedBuckets, R2_ENDPOINT_PATTERN } from './kinds';
import type { Credential } from './vault';

// Read access to backups in R2 / S3 (ListObjectsV2 + GetObject, SigV4). Only buckets
// approved on the credential, only the credential's endpoint — same rules as uploads.

export interface BucketTarget {
  kind: 'r2' | 'aws';
  bucket: string;
  /** Key prefix backups are uploaded under ("" or "prod/"). */
  prefix: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export async function bucketTarget(cred: Credential, bucketIn: string): Promise<BucketTarget> {
  if (cred.kind !== 'r2' && cred.kind !== 'aws') throw new HttpError(400, 'Choose an R2 or AWS credential for the backup source');
  const bucket = bucketIn || cred.fields.bucket;
  if (!approvedBuckets(cred.fields).includes(bucket)) throw new HttpError(400, `Bucket "${bucket}" is not approved for "${cred.name}"`);
  const { accessKeyId, secretAccessKey } = cred.fields;
  if (cred.kind === 'r2') {
    if (!new RegExp(R2_ENDPOINT_PATTERN).test(cred.fields.endpoint ?? '')) throw new HttpError(400, `The R2 endpoint of "${cred.name}" is not valid`);
    const prefix = (cred.fields.prefix ?? '').replace(/^\/+|\/+$/g, '');
    return { kind: 'r2', bucket, prefix: prefix ? `${prefix}/` : '', endpoint: cred.fields.endpoint.replace(/\/+$/, ''), region: 'auto', accessKeyId, secretAccessKey };
  }
  // backup.js uploads to AWS at the bucket root. Region: the credential's for its default bucket, else detected.
  let region = bucket === cred.fields.bucket ? cred.fields.region ?? '' : '';
  if (!region) {
    try {
      const r = await s3Request('HEAD', new URL(`https://s3.us-east-1.amazonaws.com/${encodeURIComponent(bucket)}`), 'us-east-1', accessKeyId, secretAccessKey);
      region = r.headers.get('x-amz-bucket-region')?.trim() || 'us-east-1';
    } catch { region = 'us-east-1'; }
  }
  return { kind: 'aws', bucket, prefix: '', endpoint: `https://s3.${region}.amazonaws.com`, region, accessKeyId, secretAccessKey };
}

const encKey = (key: string) => key.split('/').map(rfc3986).join('/');
const xmlText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function get(t: BucketTarget, url: URL, what: string): Promise<string> {
  let res: Response;
  try { res = await s3Request('GET', url, t.region, t.accessKeyId, t.secretAccessKey); } catch {
    throw new HttpError(502, `Could not reach the ${t.kind === 'r2' ? 'R2' : 'S3'} endpoint`);
  }
  if (!res.ok) {
    const why = s3Reason(t.kind, res.status, await res.text().catch(() => ''), t.bucket);
    if (res.status === 404 && why.code !== 'NoSuchBucket') throw new HttpError(404, `${what} not found in "${t.bucket}"`);
    throw new HttpError(502, `Reading ${what} from "${t.bucket}" failed: ${why.text}`);
  }
  return res.text();
}

/** ListObjectsV2 under `prefix`; with `delimiter`, returns the "folders" too. Follows continuation tokens. */
export async function listObjects(t: BucketTarget, prefix: string, delimiter = ''): Promise<{ keys: { key: string; modified: string }[]; folders: string[] }> {
  const keys: { key: string; modified: string }[] = [];
  const folders: string[] = [];
  let token = '';
  for (let page = 0; page < 200; page++) {
    const url = new URL(`${t.endpoint}/${rfc3986(t.bucket)}`);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    if (delimiter) url.searchParams.set('delimiter', delimiter);
    if (token) url.searchParams.set('continuation-token', token);
    const xml = await get(t, url, 'the backup list');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
      if (key) keys.push({ key: xmlText(key), modified: /<LastModified>([^<]+)<\/LastModified>/.exec(m[1])?.[1] ?? '' });
    }
    for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g)) folders.push(xmlText(m[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') : '';
    if (!token) break;
  }
  return { keys, folders };
}

export async function getObject(t: BucketTarget, key: string): Promise<string> {
  return get(t, new URL(`${t.endpoint}/${rfc3986(t.bucket)}/${encKey(key)}`), `"${key}"`);
}
