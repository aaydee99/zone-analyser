import { route } from '@/lib/http';
import { listCredentialOptions } from '@/lib/vault';

export const dynamic = 'force-dynamic';

/** Names and kinds only, for choosing a credential when starting a backup. */
export const GET = route(async () => ({ options: await listCredentialOptions() }), { perm: 'runs:start' });
