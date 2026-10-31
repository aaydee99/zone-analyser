import { HttpError, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { canManageRole } from '@/lib/rbac';
import { getLink, removeLink } from '@/lib/slack-users';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ slackId: string }> };

/** Takes a Slack user off the list: the command refuses them from then on. */
export const DELETE = route<Ctx>(async (_req, { params }, me) => {
  const id = (await params).slackId.toUpperCase();
  const link = await getLink(id);
  if (!link) throw new HttpError(404, 'That Slack user is not on the list');
  if (link.userId !== me.id && link.role && !canManageRole(me.role, link.role)) throw new HttpError(403, 'You may remove only yourself or users whose role you manage');
  await removeLink(id);
  await audit(me, 'slack.user_unlinked', id, { user: link.email });
  return { ok: true };
}, { perm: 'settings:write' });
