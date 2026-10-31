import { HttpError, route } from '@/lib/http';
import { pagesDeployments } from '@/lib/cf-actions';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ account: string; project: string }> };

/** A Pages project's recent production deployments, to pick one to roll back to. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { account, project } = await params;
  if (!/^[a-f0-9]{32}$/i.test(account) || !/^[A-Za-z0-9_-]{1,128}$/.test(project)) throw new HttpError(404, 'Unknown project');
  return { project, deployments: await pagesDeployments(account, project) };
}, { perm: 'cloudflare:act' });
