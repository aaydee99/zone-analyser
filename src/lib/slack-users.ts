import 'server-only';
import { db } from './supabase';
import { isRole, type Role } from './rbac';
import { mustR } from './report-store';
import type { Me } from './auth';

// Who may use the Slack command (supabase/migrations/0020_reports.sql, slack_users): an allow-list
// of Slack member IDs, each acting as one console user, with that user's current role. Anyone not
// on it is refused (default deny). Admins keep the list in Settings › Slack.

export interface SlackLink {
  slackUserId: string;
  teamId: string | null;
  userId: string;
  email: string;
  name: string;
  role: Role | null;
  disabled: boolean;
  note: string;
  addedAt: string;
  addedBy: string | null;
}

export const SLACK_USER = /^[UW][A-Z0-9]{2,30}$/;
export const SLACK_TEAM = /^[TE][A-Z0-9]{2,30}$/;

interface Row { slack_user_id: string; team_id: string | null; user_id: string; note: string; added_at: string; added_by: string | null }
interface Profile { id: string; email: string; display_name: string; role: string; disabled: boolean }

async function profiles(ids: string[]): Promise<Map<string, Profile>> {
  if (!ids.length) return new Map();
  const rows = mustR(await db().from('profiles').select('id, email, display_name, role, disabled').in('id', ids), 'Reading users') as Profile[];
  return new Map(rows.map((p) => [p.id, p]));
}

const toLink = (r: Row, p: Profile | undefined): SlackLink => ({
  slackUserId: r.slack_user_id, teamId: r.team_id, userId: r.user_id, email: p?.email ?? '', name: p?.display_name ?? '',
  role: p && isRole(p.role) ? p.role : null, disabled: !p || p.disabled, note: r.note, addedAt: r.added_at, addedBy: r.added_by,
});

/** One page of the allow-list, newest first. */
export async function listLinks(offset: number, limit: number): Promise<{ links: SlackLink[]; total: number }> {
  const res = await db().from('slack_users').select('slack_user_id, team_id, user_id, note, added_at, added_by', { count: 'exact' })
    .order('added_at', { ascending: false }).order('slack_user_id', { ascending: true }).range(offset, offset + limit - 1);
  const rows = mustR(res, 'Reading Slack users') as Row[];
  const p = await profiles([...new Set(rows.map((r) => r.user_id))]);
  return { links: rows.map((r) => toLink(r, p.get(r.user_id))), total: res.count ?? rows.length };
}

export async function getLink(slackUserId: string): Promise<SlackLink | null> {
  if (!SLACK_USER.test(slackUserId)) return null;
  const row = mustR(await db().from('slack_users').select('slack_user_id, team_id, user_id, note, added_at, added_by').eq('slack_user_id', slackUserId).maybeSingle(), 'Reading Slack users') as Row | null;
  if (!row) return null;
  return toLink(row, (await profiles([row.user_id])).get(row.user_id));
}

export async function saveLink(l: { slackUserId: string; teamId: string | null; userId: string; note: string }, by: string): Promise<SlackLink> {
  const rows = mustR(await db().from('slack_users').upsert({ slack_user_id: l.slackUserId, team_id: l.teamId, user_id: l.userId, note: l.note, added_by: by, added_at: new Date().toISOString() })
    .select('slack_user_id, team_id, user_id, note, added_at, added_by'), 'Saving the Slack user') as Row[];
  return toLink(rows[0], (await profiles([l.userId])).get(l.userId));
}

export async function removeLink(slackUserId: string): Promise<boolean> {
  if (!SLACK_USER.test(slackUserId)) return false;
  const rows = mustR(await db().from('slack_users').delete().eq('slack_user_id', slackUserId).select('slack_user_id'), 'Removing the Slack user') as Row[];
  return rows.length > 0;
}

/** The console user a Slack user acts as: only an allow-listed member of an allowed workspace, whose console account is enabled. */
export async function slackActor(slackUserId: string, teamId: string): Promise<Me | null> {
  const l = await getLink(slackUserId);
  if (!l || l.disabled || !l.role) return null;
  if (l.teamId && l.teamId !== teamId) return null;
  // Not a session: the command runs with this identity for one answer, and nothing it does writes.
  return { id: l.userId, email: l.email, name: l.name, role: l.role, sessionHash: `slack:${slackUserId}`, expiresAt: Date.now() + 60_000 };
}

/** A user's profile, to check it exists before linking. */
export async function profileOf(userId: string): Promise<Profile | null> {
  return (await profiles([userId])).get(userId) ?? null;
}
