import { HttpError, route } from '@/lib/http';
import { answerCommand } from '@/lib/slack-commands';

export const dynamic = 'force-dynamic';

/**
 * The Slack command's answer, as the signed-in user (?text=zone example.com): what /api/hooks/slack
 * posts back to Slack, run on the worker when the web side relays it. Also lets an admin try a
 * command in Settings › Slack. Read-only.
 */
export const GET = route(async (req, _ctx, me) => {
  const text = new URL(req.url).searchParams.get('text') ?? '';
  if (text.length > 500) throw new HttpError(400, 'The command is too long');
  return { text: await answerCommand(me, text) };
}, { perm: 'runs:read', limit: { name: 'slack-answer', max: 30 } });
