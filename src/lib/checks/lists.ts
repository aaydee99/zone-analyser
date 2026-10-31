import 'server-only';
import crypto from 'node:crypto';
import { cfList, cfOne, inParallel } from '../cf-read';
import { db } from '../supabase';
import { rulesetRefs, type ListRef, type RulesetLike } from '../list-refs';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { Problems, readStat, type CheckDef, type UnitTarget } from './common';

// IP, ASN, hostname and redirect lists (Account > Configurations > Lists), and the rules that use
// them. Once a day per account: its lists (one call) and its account-level rulesets (one call each).
// A zone's rulesets are read only when its account has lists (a few calls, once a day); zones of
// accounts without lists cost nothing but a database read. The Lists page (/console/lists) shows
// what is stored here, and reads a list's items from Cloudflare when someone opens it.

interface CfListMeta { id: string; name: string; kind?: string; num_items?: number; num_referencing_filters?: number; description?: string; created_on?: string; modified_on?: string }

/** Rulesets read per account or zone and run. */
const MAX_RULESETS = 30;

/** The account's lists as its unit stored them (name → kind), and whether it has run at all. */
async function storedLists(accountId: string): Promise<{ ran: boolean; names: Set<string> }> {
  const [res, rows] = await Promise.all([
    db().from('monitor_results').select('scope_id').eq('check_id', 'lists').eq('scope_kind', 'account').eq('scope_id', accountId).maybeSingle(),
    db().from('monitor_rows').select('data').eq('check_id', 'lists').eq('section', 'lists').eq('scope_kind', 'account').eq('scope_id', accountId).limit(1000),
  ]);
  return { ran: !!res.data, names: new Set(((rows.data ?? []) as { data: Row }[]).map((r) => String(r.data.name ?? ''))) };
}

/** The non-managed rulesets of an account or zone, with their rules. */
async function readRulesets(t: UnitTarget, base: string, p: Problems, signal?: AbortSignal): Promise<RulesetLike[]> {
  let list: RulesetLike[] = [];
  try { list = await cfList<RulesetLike>(t.token, `${base}/rulesets`, { perPage: 0, signal }); } catch (err) { p.skip('rulesets', err); return []; }
  const own = list.filter((r) => r.kind !== 'managed').slice(0, MAX_RULESETS);
  const out: RulesetLike[] = [];
  await inParallel(own, 4, async (r) => {
    try { out.push(await cfOne<RulesetLike>(t.token, `${base}/rulesets/${r.id}`, signal)); } catch (err) { p.skip('rulesets', err); }
  });
  return out;
}

const refRow = (r: ListRef, t: UnitTarget, where: 'account' | 'zone'): Row => ({
  accountId: t.accountId, zoneId: where === 'zone' ? t.id : '', list: r.list, where: where === 'zone' ? t.zoneName : 'Account', ruleset: r.ruleset, phase: r.phase,
  rule: r.rule, action: r.action, enabled: r.enabled,
});

export const lists: CheckDef = {
  id: 'lists', main: 'account', every: { zone: 24 }, stateful: ['account'], idleHours: 168,
  units: {
    account: async (a, ctx) => {
      const p = new Problems();
      const all = await cfList<CfListMeta>(a.token, `/accounts/${a.accountId}/rules/lists`, { perPage: 0, signal: ctx.signal });
      const names = new Set(all.map((l) => l.name));
      const refs = all.length ? (await readRulesets(a, `/accounts/${a.accountId}`, p, ctx.signal)).flatMap((rs) => rulesetRefs(rs, names)) : [];
      // Uses in zone rules, as the zone units of this account found them.
      const zoneUse = new Map<string, { n: number; where: Set<string> }>();
      let zonesPending = 0;
      if (all.length) {
        const [rows, pending] = await Promise.all([
          db().from('monitor_rows').select('data').eq('check_id', 'lists').eq('section', 'refs').eq('scope_kind', 'zone').eq('data->>accountId', a.accountId).limit(20_000),
          db().from('monitor_targets').select('scope_id', { count: 'exact', head: true }).eq('check_id', 'lists').eq('scope_kind', 'zone').eq('account_id', a.accountId).is('last_ok_at', null),
        ]);
        for (const r of (rows.data ?? []) as { data: Row }[]) {
          const k = String(r.data.list ?? '');
          const u = zoneUse.get(k) ?? { n: 0, where: new Set<string>() };
          u.n++; u.where.add(String(r.data.where ?? ''));
          zoneUse.set(k, u);
        }
        zonesPending = pending.count ?? 0;
      }
      const findings: NewFinding[] = [];
      const scope = { accountId: a.accountId, accountName: a.accountName || a.accountId };
      const listRows: Row[] = all.map((l) => {
        const acc = refs.filter((r) => r.list === l.name);
        const z = zoneUse.get(l.name);
        const used = acc.length + (z?.n ?? 0);
        const where = [...(acc.length ? ['Account rules'] : []), ...[...(z?.where ?? [])].slice(0, 5)].join(', ') + ((z?.where.size ?? 0) > 5 ? ` and ${(z!.where.size - 5)} more zones` : '');
        // Unused only once every zone of the account has been read.
        if (!used && !zonesPending && p.complete && !(l.num_referencing_filters ?? 0)) {
          findings.push({ key: `list:${l.id}:unused`, severity: 'info', ...scope, title: `List “${l.name}” is not used by any rule`, detail: `${l.num_items ?? 0} items. A list no rule uses does nothing — delete it, or add the rule that should use it.` });
        }
        return {
          listId: l.id, accountId: a.accountId, account: scope.accountName, name: l.name, kind: l.kind ?? 'ip', items: l.num_items ?? 0, refs: used,
          referencedBy: where || (zonesPending ? 'zones not read yet' : ''), description: l.description ?? '', modified: l.modified_on ?? null,
          _tone: used ? 'ok' : 'warn', _sort: -(l.num_items ?? 0),
        };
      });
      // Lists added or renamed: the zones of the account are read again now, to find their uses.
      const print = crypto.createHash('sha1').update([...names].sort().join('\n')).digest('hex');
      const before = (ctx.state as { print?: string } | null)?.print;
      let wake: { kind: 'zone'; ids: string[] } | undefined;
      if (all.length && print !== before) {
        const { data } = await db().from('monitor_targets').select('scope_id').eq('check_id', 'lists').eq('scope_kind', 'zone').eq('account_id', a.accountId).limit(10_000);
        const ids = ((data ?? []) as { scope_id: string }[]).map((r) => r.scope_id);
        if (ids.length) wake = { kind: 'zone', ids };
      }
      return {
        rows: { lists: listRows, refs: refs.map((r) => refRow(r, a, 'account')) }, findings, complete: p.complete, problems: p.list, state: { print }, idle: !all.length && p.complete,
        counts: { lists: all.length, items: all.reduce((n, l) => n + (l.num_items ?? 0), 0), unused: findings.length, accountRefs: refs.length }, ...(wake ? { wake } : {}),
      };
    },
    zone: async (z, ctx) => {
      const { ran, names } = await storedLists(z.accountId);
      // The account has no lists (or was not read yet): nothing to look for.
      if (!names.size) return { rows: {}, findings: [], complete: true, idle: true, ...(ran ? {} : { dueInHours: 1 }) };
      const p = new Problems();
      const refs = (await readRulesets(z, `/zones/${z.id}`, p, ctx.signal)).flatMap((rs) => rulesetRefs(rs, names));
      return { rows: { refs: refs.map((r) => refRow(r, z, 'zone')) }, findings: [], complete: p.complete, problems: p.list, counts: { zoneRefs: refs.length } };
    },
  },
  sections: [
    { key: 'lists', title: 'Lists', description: 'Largest first. Open the Lists page to see a list’s items.',
      columns: [{ key: 'name', label: 'List', kind: 'mono' }, { key: 'account', label: 'Account' }, { key: 'kind', label: 'Kind' }, { key: 'items', label: 'Items', kind: 'number' }, { key: 'refs', label: 'Rules using it', kind: 'number' }, { key: 'referencedBy', label: 'Used in' }, { key: 'modified', label: 'Changed', kind: 'date' }],
      empty: 'No lists in the accounts the tokens can read.' },
    { key: 'refs', title: 'Rules that use a list',
      columns: [{ key: 'list', label: 'List', kind: 'mono' }, { key: 'where', label: 'Zone or account' }, { key: 'ruleset', label: 'Ruleset' }, { key: 'phase', label: 'Phase', kind: 'mono' }, { key: 'rule', label: 'Rule' }, { key: 'action', label: 'Action' }, { key: 'enabled', label: 'On', kind: 'bool' }],
      empty: 'No rule uses a list.' },
  ],
  stats: (t) => [
    { label: 'Lists', value: t.counts.lists ?? 0 },
    { label: 'Items', value: t.counts.items ?? 0 },
    { label: 'Not used by any rule', value: t.counts.unused ?? 0, tone: t.counts.unused ? 'warn' : 'ok' },
    readStat(t, 'Accounts and zones read'),
  ],
};
