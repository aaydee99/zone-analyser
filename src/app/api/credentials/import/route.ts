import { HttpError, readBody, route } from '@/lib/http';
import { createCredential, VaultError, type CredentialInput } from '@/lib/vault';
import { groupedFields, type CredentialSummary } from '@/lib/kinds';

export const dynamic = 'force-dynamic';

/** KEY=value lines; strips export, quotes and trailing # comments. No variable expansion. */
function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.lastIndexOf('"') > 0) || (v.startsWith("'") && v.lastIndexOf("'") > 0)) {
      v = v.slice(1, v.lastIndexOf(v[0]));
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[m[1]] = v;
  }
  return out;
}

const real = (v: string | undefined) => !!v && !/^YOUR_.*_HERE$/.test(v);

const MAX_ENV = 64 * 1024;

/** Creates vault credentials from a pasted backup.js .env file. */
export const POST = route(async (req, _ctx, me) => {
  const { text, name } = await readBody<{ text: string; name?: string }>(req);
  if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Paste the contents of a .env file');
  // A .env file is short plain text: anything larger, or with binary / control characters, is refused.
  if (text.length > MAX_ENV) throw new HttpError(413, `A .env file is at most ${MAX_ENV / 1024} KB`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) throw new HttpError(400, 'That is not a text .env file');
  if (name !== undefined && (typeof name !== 'string' || name.length > 80)) throw new HttpError(400, 'The name is at most 80 characters');
  const env = parseDotEnv(text);
  const base = (name ?? '').trim() || 'Imported';
  // One .env = one account set: the Cloudflare account plus whatever storage the file has.
  if (!real(env.CF_API_TOKEN) || !real(env.CF_ACCOUNT_ID)) throw new HttpError(400, 'An account set needs CF_API_TOKEN and CF_ACCOUNT_ID');
  const fields: Record<string, string> = { apiToken: env.CF_API_TOKEN, accountId: env.CF_ACCOUNT_ID };
  if (real(env.R2_ACCESS_KEY_ID) && real(env.R2_SECRET_ACCESS_KEY) && real(env.R2_ENDPOINT)) {
    Object.assign(fields, groupedFields({
      accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, endpoint: env.R2_ENDPOINT,
      bucket: env.R2_BUCKET_NAME || 'terraform-backup', prefix: env.R2_PREFIX ?? '',
    }, 'r2'));
  }
  if (real(env.AWS_ACCESS_KEY_ID) && real(env.AWS_SECRET_ACCESS_KEY) && real(env.AWS_S3_BUCKET)) {
    Object.assign(fields, groupedFields({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, bucket: env.AWS_S3_BUCKET, region: env.AWS_REGION ?? '' }, 'aws'));
  }
  const drafts: CredentialInput[] = [{ kind: 'cloudflare', name: base, fields }];

  const created: CredentialSummary[] = [];
  const skipped: string[] = [];
  for (const d of drafts) {
    try {
      created.push(await createCredential(me, d));
    } catch (e) {
      // Validation messages are shown; anything else is logged and summarised.
      if (!(e instanceof VaultError || e instanceof HttpError)) console.error(`[import] ${d.name}:`, e);
      skipped.push(`${d.name}: ${e instanceof VaultError || e instanceof HttpError ? e.message : 'could not be saved'}`);
    }
  }
  return { created, skipped };
}, { perm: 'vault:access' });
