import { HttpError, readBody, route } from '@/lib/http';
import { audit } from '@/lib/audit';
import { canManageRole, isRole } from '@/lib/rbac';
import { isUuid } from '@/lib/report-store';
import { SLACK_TEAM, SLACK_USER, listLinks, profileOf, saveLink } from '@/lib/slack-users';
import { commandName } from '@/lib/slack-commands';

export const dynamic = 'force-dynamic';

/** The Slack users allowed to use the command, newest first (?offset=&limit=, up to 200), and whether Slack is set up. */
export const GET = route(async (req) => {
  const u = new URL(req.url).searchParams;
  const offset = Math.max(0, Math.floor(Number(u.get('offset')) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(u.get('limit')) || 50)));
  const { links, total } = await listLinks(offset, limit);
  const base = (process.env.CONSOLE_PUBLIC_URL || '').replace(/\/+$/, '');
  return {
    links, total, offset, generatedAt: new Date().toISOString(),
    setup: { signingSecret: !!process.env.SLACK_SIGNING_SECRET?.trim(), team: process.env.SLACK_TEAM_ID?.trim() || null, command: commandName(), requestUrl: base ? `${base}/api/hooks/slack` : null },
  };
}, { perm: 'settings:read' });

/**
 * Allows a Slack user: { slackUserId: "U…", userId: <console user id>, teamId?: "T…", note? }. The
 * Slack user then acts as that console user (with its role). An admin may link only users whose role
 * they manage, or themselves.
 */
export const POST = route(async (req, _ctx, me) => {
  const b = await readBody<{ slackUserId?: unknown; userId?: unknown; teamId?: unknown; note?: unknown }>(req);
  const slackUserId = typeof b.slackUserId === 'string' ? b.slackUserId.trim().toUpperCase() : '';
  if (!SLACK_USER.test(slackUserId)) throw new HttpError(400, 'A Slack member ID starts with U or W (find it in the person’s Slack profile › ⋮ › Copy member ID)');
  const teamId = typeof b.teamId === 'string' && b.teamId.trim() ? b.teamId.trim().toUpperCase() : null;
  if (teamId && !SLACK_TEAM.test(teamId)) throw new HttpError(400, 'A Slack workspace ID starts with T (or E for an Enterprise Grid)');
  const userId = typeof b.userId === 'string' ? b.userId.trim() : '';
  if (!isUuid(userId)) throw new HttpError(400, 'Choose a console user');
  const p = await profileOf(userId);
  if (!p || !isRole(p.role)) throw new HttpError(404, 'User not found');
  if (p.disabled) throw new HttpError(400, 'That console user is disabled');
  if (p.id !== me.id && !canManageRole(me.role, p.role)) throw new HttpError(403, 'You may link only yourself or users whose role you manage');
  const note = typeof b.note === 'string' ? b.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
  const link = await saveLink({ slackUserId, teamId, userId, note }, me.email);
  await audit(me, 'slack.user_linked', slackUserId, { user: p.email, role: p.role, team: teamId });
  return { link };
}, { perm: 'settings:write' });
