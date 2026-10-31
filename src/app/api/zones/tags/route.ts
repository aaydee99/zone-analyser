import { route } from '@/lib/http';
import { tagsAndOwners } from '@/lib/zone-meta';

export const dynamic = 'force-dynamic';

/** Every zone tag with how many zones carry it, and every owner (for pickers and the tags page). */
export const GET = route(async () => tagsAndOwners(), { perm: 'runs:read' });
