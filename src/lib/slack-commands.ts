import 'server-only';
import { db } from './supabase';
import { can } from './rbac';
import { listZones } from './zone-explorer';
import { CHECK, CHECKS, SEVERITIES, type CheckId, type Severity } from './monitor-types';
import { mustR } from './report-store';
import { slackEscape as esc } from './report-render';
import type { ZoneListItem } from './zone-catalog';
import type { Me } from './auth';

// The read-only Slack command (/castellan): answers from stored data — the zone list, monitoring
// findings and coverage, zone tags — plus the zone search index and Ray ID lookups when the console
// has them. Nothing here changes anything, in the console or in Cloudflare. Findings are limited to
// the checks the linked console user's role may see.

export const commandName = () => (process.env.SLACK_COMMAND?.trim() || '/castellan').replace(/^(?!\/)/, '/');

export function helpText() {
  const c = commandName();
  return [
    `*${c}* — read-only answers from the console`,
    `• \`${c} zone <name>\` — status, plan, account, tags, owner, open findings and monitoring health`,
    `• \`${c} findings <zone>\` — the zone's open findings, worst first`,
    `• \`${c} search <text>\` — find a value (an IP, a host name, a rule) in every zone's stored configuration`,
    `• \`${c} ray <ray id> [zone]\` — what happened to one request`,
    `• \`${c} help\` — this list`,
  ].join('\n');
}

const visibleChecks = (me: Me): CheckId[] => CHECKS.filter((c) => can(me.role, c.perm)).map((c) => c.id);
import { compactNum as whole } from '@/lib/num';

async function findZone(arg: string): Promise<{ zone: ZoneListItem | null; similar: ZoneListItem[] }> {
  const name = arg.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  const { zones } = await listZones();
  const zone = zones.find((z) => z.name.toLowerCase() === name || z.id === name) ?? null;
  // A host inside a zone ("www.example.com") is the zone it belongs to (the longest match).
  const parent = zone ?? zones.filter((z) => name.endsWith(`.${z.name.toLowerCase()}`)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
  const similar = parent ? [] : zones.filter((z) => z.name.toLowerCase().includes(name)).slice(0, 5);
  return { zone: parent, similar };
}

const notFound = (arg: string, similar: ZoneListItem[]) =>
  `No zone called “${esc(arg)}” is in the console's zone list.${similar.length ? ` Did you mean: ${similar.map((z) => esc(z.name)).join(', ')}?` : ''}`;

async function counts(me: Me, zoneId: string): Promise<Record<Severity, number>> {
  const now = new Date().toISOString();
  const rows = mustR(await db().rpc('report_finding_counts', { p_checks: visibleChecks(me), p_accounts: null, p_zones: [zoneId], p_since: now, p_until: now }), 'Counting findings') as { severity: Severity; open: number }[] | null;
  const out: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of rows ?? []) if (SEVERITIES.includes(r.severity)) out[r.severity] = Number(r.open);
  return out;
}

async function zoneAnswer(me: Me, arg: string): Promise<string> {
  if (!arg) return `Which zone? \`${commandName()} zone example.com\``;
  const { zone, similar } = await findZone(arg);
  if (!zone) return notFound(arg, similar);
  const lines = [`*${esc(zone.name)}*  ·  ${esc(zone.status)}${zone.paused ? ' (paused)' : ''}  ·  ${esc(zone.plan || 'unknown plan')}`, `Account: ${esc(zone.accountName || zone.accountId)}`];
  try {
    const m = (await import('@/lib/zone-meta')) as { metaOf?: (ids: string[]) => Promise<Map<string, { tags: string[]; owner: string; contact: string }>> };
    const meta = m.metaOf ? (await m.metaOf([zone.id])).get(zone.id) : undefined;
    if (meta?.tags.length) lines.push(`Tags: ${meta.tags.map((t) => `\`${esc(t)}\``).join(' ')}`);
    if (meta?.owner) lines.push(`Owner: ${esc(meta.owner)}${meta.contact ? ` (${esc(meta.contact)})` : ''}`);
  } catch { /* no zone tags in this console */ }
  const c = await counts(me, zone.id);
  const open = Object.values(c).reduce((a, b) => a + b, 0);
  lines.push(`Open findings: ${open ? SEVERITIES.filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(', ') : 'none'}`);
  const cov = mustR(await db().rpc('report_coverage', { p_checks: visibleChecks(me), p_accounts: null, p_zones: [zone.id] }), 'Reading coverage') as { check_id: CheckId; targets: number; read_ok: number; failing: number; never: number }[] | null;
  if (cov?.length) {
    const failing = cov.filter((x) => Number(x.failing) > 0).map((x) => CHECK[x.check_id]?.label ?? x.check_id);
    const never = cov.filter((x) => Number(x.never) > 0).length;
    lines.push(`Monitoring: ${whole(cov.length)} check${cov.length === 1 ? '' : 's'} on this zone${failing.length ? ` — failing: ${failing.map(esc).join(', ')}` : ', all read'}${never ? ` (${never} not read yet)` : ''}`);
  } else lines.push('Monitoring: this zone has not been checked yet');
  return lines.join('\n');
}

async function findingsAnswer(me: Me, arg: string): Promise<string> {
  if (!arg) return `Which zone? \`${commandName()} findings example.com\``;
  const { zone, similar } = await findZone(arg);
  if (!zone) return notFound(arg, similar);
  const now = new Date().toISOString();
  const rows = mustR(await db().rpc('report_findings_list', { p_checks: visibleChecks(me), p_accounts: null, p_zones: [zone.id], p_since: now, p_until: now, p_kind: 'open', p_limit: 15 }), 'Reading findings') as
    { check_id: CheckId; severity: Severity; title: string; first_seen: string }[] | null;
  if (!rows?.length) return `*${esc(zone.name)}*: no open findings.`;
  const c = await counts(me, zone.id);
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return [`*${esc(zone.name)}* — ${whole(total)} open finding${total === 1 ? '' : 's'}${total > rows.length ? ` (the ${whole(rows.length)} worst)` : ''}`,
    ...rows.map((f) => `• [${f.severity.toUpperCase()}] ${esc(CHECK[f.check_id]?.label ?? f.check_id)}: ${esc(f.title)} (since ${f.first_seen.slice(0, 10)})`)].join('\n');
}

async function searchAnswer(arg: string): Promise<string> {
  if (!arg) return `What should I look for? \`${commandName()} search 192.0.2.10\``;
  let mod: { searchZones?: (q: string, o: { limit?: number }) => Promise<{ hits: { zoneName: string; where: string; snippet: { before: string; match: string; after: string } }[]; total: number; capped: boolean; note?: string }> } | null = null;
  try { mod = await import('@/lib/zone-search'); } catch { mod = null; }
  if (mod?.searchZones) {
    const r = await mod.searchZones(arg, { limit: 10 });
    if (!r.hits.length) return `Nothing in the stored configuration matches “${esc(arg)}”.${r.note ? ` (${esc(r.note)})` : ''}`;
    return [`${whole(r.total)}${r.capped ? '+' : ''} match${r.total === 1 ? '' : 'es'} for “${esc(arg)}”${r.total > r.hits.length ? ` (first ${whole(r.hits.length)})` : ''}:`,
      ...r.hits.map((h) => `• *${esc(h.zoneName)}* — ${esc(h.where)}: ${esc(h.snippet.before)}*${esc(h.snippet.match)}*${esc(h.snippet.after)}`)].join('\n');
  }
  // Without the search index: zone names only.
  const q = arg.trim().toLowerCase();
  const hits = (await listZones()).zones.filter((z) => z.name.toLowerCase().includes(q));
  if (!hits.length) return `No zone name contains “${esc(arg)}” (configuration search is not set up on this console).`;
  return [`${whole(hits.length)} zone name${hits.length === 1 ? '' : 's'} contain “${esc(arg)}”:`, ...hits.slice(0, 10).map((z) => `• ${esc(z.name)} (${esc(z.accountName)})`)].join('\n');
}

async function rayAnswer(args: string[]): Promise<string> {
  const [ray, where] = args;
  if (!ray) return `Which Ray ID? \`${commandName()} ray 8f3a1b2c4d5e6f70 example.com\``;
  let mod: { lookupRay?: (input: string, o: { zoneId?: string; host?: string; all?: boolean }) => Promise<unknown>; rayText?: (r: never) => string } | null = null;
  try { mod = await import('@/lib/ray-lookup'); } catch { mod = null; }
  if (!mod?.lookupRay || !mod.rayText) return 'Ray ID lookups are not available on this console yet.';
  const opts = !where ? { all: true } : /^[a-f0-9]{32}$/i.test(where) ? { zoneId: where.toLowerCase() } : { host: where.toLowerCase() };
  const r = await mod.lookupRay(ray, opts);
  return esc(mod.rayText(r as never));
}

/** The answer to one command, as Slack text. Errors the console raises on purpose are answered as they are. */
export async function answerCommand(me: Me, text: string): Promise<string> {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const sub = (words.shift() ?? 'help').toLowerCase();
  const arg = words.join(' ');
  try {
    switch (sub) {
      case 'zone': return await zoneAnswer(me, arg);
      case 'findings': return await findingsAnswer(me, arg);
      case 'search': return await searchAnswer(arg);
      case 'ray': return await rayAnswer(words);
      case 'help': case '': return helpText();
      default: return `I do not know “${esc(sub)}”.\n${helpText()}`;
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status && status < 500) return esc((err as Error).message);
    if (status === 503) return esc((err as Error).message);
    console.error('[slack] command failed:', err);
    return 'Something went wrong on the server while answering — see the console log.';
  }
}
