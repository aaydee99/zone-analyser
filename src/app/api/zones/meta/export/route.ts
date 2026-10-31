import { route } from '@/lib/http';
import { exportCsv } from '@/lib/zone-meta';
import { attachment } from '@/lib/zone-routes';

export const dynamic = 'force-dynamic';

/** Every zone with its tags, owner, contact and notes as CSV: fill it in and import it again. */
export const GET = route(async () => attachment(`zone-tags-${new Date().toISOString().slice(0, 10)}.csv`, await exportCsv(), 'text/csv; charset=utf-8'),
  { perm: 'runs:read', limit: { name: 'zone-meta-export', max: 10 } });
