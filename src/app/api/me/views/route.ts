import { readBody, route } from '@/lib/http';
import { checkPath, listViews, saveView } from '@/lib/zone-prefs';

export const dynamic = 'force-dynamic';

/** The signed-in user's saved views, of one page (?path=/console/zone-explorer) or all. */
export const GET = route(async (req, _ctx, me) => {
  const path = new URL(req.url).searchParams.get('path');
  return { views: await listViews(me.id, path ? checkPath(path) : undefined) };
}, { perm: 'runs:read' });

/** Saves a view ({ path, name, query }); the same name on the same page replaces it. */
export const POST = route(async (req, _ctx, me) => ({ view: await saveView(me.id, await readBody(req)) }), { perm: 'runs:read' });
