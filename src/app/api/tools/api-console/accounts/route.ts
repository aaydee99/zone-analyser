import { route } from '@/lib/http';
import { credentialAccounts } from '@/lib/api-console';

export const dynamic = 'force-dynamic';

/** The accounts one credential's token reaches: ?credentialId=. */
export const GET = route(async (req) => ({ accounts: await credentialAccounts(new URL(req.url).searchParams.get('credentialId')) }), { perm: 'cloudflare:query' });
