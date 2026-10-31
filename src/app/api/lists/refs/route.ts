import { HttpError, route } from '@/lib/http';
import { listRefs } from '@/lib/lists';
import type { RefsView } from '@/lib/lists-types';

export const dynamic = 'force-dynamic';

const ACCOUNT = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[A-Za-z0-9_]{1,50}$/;

/** The rules that use one list, as monitoring found them: ?account=&list=<name>&offset=&limit= (up to 200). */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const account = u.get('account') ?? '', list = u.get('list') ?? '';
  if (!ACCOUNT.test(account) || !NAME.test(list)) throw new HttpError(400, 'Unknown list');
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const view: RefsView = { ...(await listRefs({ account, list, offset, limit })), offset };
  return view;
}, { perm: 'runs:read' });
