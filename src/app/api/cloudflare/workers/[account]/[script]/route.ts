import { HttpError, route } from '@/lib/http';
import { workerVersions } from '@/lib/cf-actions';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ account: string; script: string }> };

/** A Worker's recent versions, to pick one to roll back to. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { account, script } = await params;
  if (!/^[a-f0-9]{32}$/i.test(account) || !/^[A-Za-z0-9_-]{1,128}$/.test(script)) throw new HttpError(404, 'Unknown Worker');
  return workerVersions(account, script);
}, { perm: 'cloudflare:act' });
