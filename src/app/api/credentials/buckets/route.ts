import { HttpError, readBody, route } from '@/lib/http';
import { getCredential } from '@/lib/vault';
import { listBuckets } from '@/lib/providers';
import { storageFields } from '@/lib/kinds';

export const dynamic = 'force-dynamic';

/**
 * Buckets an R2 / AWS key pair can list, for filling in an account set's approved buckets.
 * Uses the values typed in the editor (account-set field names, e.g. r2AccessKeyId); with `id`,
 * blank secrets fall back to the stored ones.
 */
export const POST = route(async (req, _ctx, me) => {
  const { kind, fields, id } = await readBody<{ kind?: string; fields?: Record<string, string>; id?: string }>(req);
  if (kind !== 'r2' && kind !== 'aws') throw new HttpError(400, 'Only R2 and AWS credentials have buckets');
  const typed = Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
  let merged = typed;
  if (id) {
    const stored = await getCredential(me, id);
    if (stored.kind !== 'cloudflare' && stored.kind !== kind) throw new HttpError(400, 'Credential type mismatch');
    merged = { ...stored.fields, ...typed };
  }
  // Account-set field names (r2AccessKeyId …) → the plain names the S3 client uses.
  const plain = storageFields(merged, kind);
  if (plain) merged = { ...merged, ...plain };
  try {
    return { buckets: await listBuckets(kind, merged) };
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : 'Could not list buckets');
  }
}, { perm: 'vault:access', limit: { name: 'buckets', max: 20 } });
