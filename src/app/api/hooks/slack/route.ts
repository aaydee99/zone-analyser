import crypto from 'node:crypto';
import { NextResponse, after } from 'next/server';
import { HttpError, clientKey, rateLimit } from '@/lib/http';
import { isAllowedHost } from '@/lib/hosts';
import { hitLimit } from '@/lib/rate-limit';
import { safePost } from '@/lib/safe-url';
import { audit } from '@/lib/audit';
import { isWebRole, relayJson } from '@/lib/worker-link';
import { isSlackResponseUrl, parseSlashCommand, verifySlack } from '@/lib/slack-verify';
import { slackActor } from '@/lib/slack-users';
import { answerCommand, commandName, helpText } from '@/lib/slack-commands';
import { BRAND } from '@/lib/brand';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MAX_BODY = 64 * 1024;

const reply = (text: string) => NextResponse.json({ response_type: 'ephemeral', text });

/**
 * Slack's slash command (/castellan). No session: the request must carry Slack's signature
 * (SLACK_SIGNING_SECRET, X-Slack-Signature over "v0:timestamp:body", at most five minutes old, each
 * signature once). Slack sends no Origin header, so like /api/hooks/cloudflare this route checks the
 * signature instead of the origin (publicRoute() would refuse it). Only allow-listed Slack users get
 * an answer, as the console user they are linked to. Slack wants an answer within 3 seconds: this
 * acknowledges at once and posts the answer to the command's response_url (only
 * https://hooks.slack.com/…). Read-only: no command changes anything.
 */
export async function POST(req: Request) {
  try {
    if (!isAllowedHost(req.headers.get('host'))) throw new HttpError(403, 'Host not allowed');
    await rateLimit(`hook-slack:${clientKey(req)}`, 120);
    const secret = process.env.SLACK_SIGNING_SECRET?.trim() ?? '';
    // Not set up: as if the route did not exist.
    if (!secret) throw new HttpError(404, 'Not found');
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw new HttpError(413, 'Too large');
    const body = await req.text();
    if (body.length > MAX_BODY) throw new HttpError(413, 'Too large');
    const sig = req.headers.get('x-slack-signature');
    const check = verifySlack(secret, req.headers.get('x-slack-request-timestamp'), sig, body);
    if (!check.ok) throw new HttpError(401, 'Not authorised');
    // A signature is good for five minutes: accept each one once, so a copied request cannot be sent again.
    const once = await hitLimit(`slack-sig:${crypto.createHash('sha256').update(sig!).digest('hex')}`, 6 * 60_000, 1);
    if (!once.allowed) throw new HttpError(401, 'Not authorised');

    const cmd = parseSlashCommand(body);
    const team = process.env.SLACK_TEAM_ID?.trim();
    if (team && cmd.teamId !== team) return reply(`This Slack workspace may not use ${BRAND.name}.`);
    if (cmd.command && cmd.command !== commandName()) return reply(`${BRAND.name} answers ${commandName()} only.`);
    if (!/^[UW][A-Z0-9]{2,30}$/.test(cmd.userId)) return reply('Slack did not say who you are.');
    let me: Awaited<ReturnType<typeof slackActor>>;
    try { me = await slackActor(cmd.userId, cmd.teamId); } catch (err) {
      if (err instanceof HttpError && err.status === 503) return reply(`${BRAND.name} is not ready for Slack yet: ${err.message}`);
      throw err;
    }
    if (!me) return reply(`Your Slack account is not allowed to use ${BRAND.name}. Ask an admin to add your Slack member ID (${cmd.userId}) in Settings › Slack.`);
    try { await rateLimit(`slack-user:${cmd.userId}`, 20); } catch { return reply('Too many requests — try again in a minute.'); }

    const sub = (cmd.text.split(/\s+/)[0] || 'help').toLowerCase();
    if (sub === 'help') return reply(helpText());
    if (!isSlackResponseUrl(cmd.responseUrl)) return reply('Slack sent no address to answer to.');
    await audit(me, 'slack.command', sub, { slackUser: cmd.userId, team: cmd.teamId, text: cmd.text.slice(0, 200) });

    // After the acknowledgement: the answer, from the worker when this is the web side (it reads Cloudflare and the stored data there).
    after(async () => {
      let text: string;
      try {
        if (isWebRole()) {
          const r = await relayJson<{ text: string }>(me, `/api/slack/answer?text=${encodeURIComponent(cmd.text)}`, 240_000);
          text = r?.text ?? 'The worker did not answer — try again in a moment.';
        } else text = await answerCommand(me, cmd.text);
      } catch (err) {
        console.error('[hooks/slack] answer failed:', err);
        text = 'Something went wrong on the server while answering — see the console log.';
      }
      const r = await safePost(cmd.responseUrl, JSON.stringify({ response_type: 'ephemeral', replace_original: true, text: text.slice(0, 3_900) }), { timeoutMs: 15_000, label: 'slack-response' });
      if (!r.ok) console.warn(`[hooks/slack] the answer could not be posted (${r.error})`);
    });
    return reply('Looking that up…');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[hooks/slack]', err);
    return NextResponse.json({ ok: false }, { status, headers: err instanceof HttpError ? err.headers : undefined });
  }
}
