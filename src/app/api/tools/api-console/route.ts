import { route } from '@/lib/http';
import { consoleCredentials } from '@/lib/api-console';

export const dynamic = 'force-dynamic';

/** The stored Cloudflare credentials the API console can read with (names only). */
export const GET = route(async () => ({ credentials: await consoleCredentials() }), { perm: 'cloudflare:query' });
