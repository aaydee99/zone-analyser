import 'server-only';
import { cfList } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { notAvailable, readStat, type CheckDef } from './common';
import { compactNum } from '../num';
import { moveOf, planPageRule, type PageRuleLike } from '../pagerule-migration';

// Page Rules are being replaced by Cache, Configuration, Redirect, Origin and Transform Rules
// (developers.cloudflare.com/rules/reference/page-rules-migration). For every Page Rule still in
// use, this says which rules it becomes (lib/pagerule-migration.ts): the rule type, where to create
// it, its match (the Page Rule's URL as a filter expression, or a wildcard pattern for a redirect)
// and each field to set with its value; a few settings have no direct replacement. A zone without
// Page Rules is looked at again once a week.

interface PageRule extends PageRuleLike { modified_on?: string }

const show = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export const pagerules: CheckDef = {
  id: 'pagerules', main: 'zone', idleHours: 168,
  units: {
    zone: async (z, ctx) => {
      const scope = { zoneId: z.id, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
      let rules: PageRule[];
      try { rules = await cfList<PageRule>(z.token, `/zones/${z.id}/pagerules`, { perPage: 0, signal: ctx.signal }); } catch (err) {
        if (notAvailable(err)) return { rows: { plan: [], rules: [] }, findings: [], complete: true, idle: true, counts: { zonesWith: 0, settings: 0, decide: 0, toCreate: 0, movable: 0 } };
        throw err;
      }
      const rows: Row[] = [];
      const plan: Row[] = [];
      const findings: NewFinding[] = [];
      let blocked = 0, movable = 0;
      // Page Rules: the first match wins (priority 1 first). The new rules: every match applies and the
      // last one wins — so a higher-priority Page Rule's rule goes after the others in its phase.
      const ordered = [...rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      for (const r of ordered) {
        const p = planPageRule(r);
        if (p.verdict === 'Yes') movable++;
        for (const a of r.actions ?? []) {
          const m = moveOf(a.id, a.value);
          if (m.none) blocked++;
          rows.push({ zone: z.zoneName, priority: r.priority ?? null, url: p.url, status: r.status ?? '', setting: a.id, value: show(a.value), moveTo: m.none ? (m.product ? `${m.product} — by hand: no direct replacement` : 'No direct replacement') : m.product, set: [m.set, m.note].filter(Boolean).join(' — '), _tone: m.none ? 'warn' : null, _sort: m.none ? 0 : 1 });
        }
        for (const x of p.rules) {
          plan.push({ zone: z.zoneName, priority: r.priority ?? null, url: p.url, status: r.status ?? '', migrate: p.verdict, create: x.product, where: x.where, match: x.match, set: x.set.join(' · '), notes: x.notes.join('; '), _tone: p.verdict === 'Yes' ? 'ok' : 'warn', _sort: r.priority ?? 0 });
        }
        if (!p.rules.length) plan.push({ zone: z.zoneName, priority: r.priority ?? null, url: p.url, status: r.status ?? '', migrate: 'No', create: '—', where: '—', match: '—', set: p.manual.map((m) => `${m.setting}: ${m.what}`).join(' · '), notes: 'Nothing to recreate as a rule: decide by hand', _tone: 'warn', _sort: r.priority ?? 0 });
      }
      const active = rules.filter((r) => r.status !== 'disabled').length;
      if (active) findings.push({ key: `${z.id}:migrate`, severity: blocked ? 'medium' : 'low', title: `${active} Page Rule${active === 1 ? '' : 's'} on ${z.zoneName} to migrate`, detail: blocked ? `${compactNum(blocked)} setting${blocked === 1 ? ' has' : 's have'} no direct replacement and need a decision.` : 'Each setting has a modern rule to move to.', ...scope });
      return { rows: { plan, rules: rows }, findings, complete: true, idle: !rules.length, counts: { zonesWith: rules.length ? 1 : 0, settings: rows.length, decide: blocked, toCreate: plan.filter((x) => x.create !== '—').length, movable } };
    },
  },
  sections: [{
    key: 'plan', title: 'Which Page Rule becomes which new rule',
    description: 'One row per rule to create, from Cloudflare’s Page Rules migration guide. Settings of one Page Rule that belong to different rule types become separate rules with the same match. Page Rules stop at the first match; the new rules all apply and the last match wins, so the rows are listed lowest priority first: create them in that order within each rule type. Check each one, then delete the Page Rule.',
    columns: [{ key: 'zone', label: 'Zone' }, { key: 'priority', label: 'Priority', kind: 'number' }, { key: 'url', label: 'Page Rule URL', kind: 'mono' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'migrate', label: 'Can migrate', kind: 'status' }, { key: 'create', label: 'Create' }, { key: 'where', label: 'Where' }, { key: 'match', label: 'Match', kind: 'mono' }, { key: 'set', label: 'Set' }, { key: 'notes', label: 'Notes' }],
    empty: 'No Page Rules in the zones read — nothing to migrate.',
  }, {
    key: 'rules', title: 'Each Page Rule setting and where it goes', description: 'Every setting of every Page Rule: the rule type that replaces it and the exact field and value to set there. Settings with no direct replacement need a decision.',
    columns: [{ key: 'zone', label: 'Zone' }, { key: 'url', label: 'URL pattern', kind: 'mono' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'setting', label: 'Setting', kind: 'mono' }, { key: 'value', label: 'Value', kind: 'mono' }, { key: 'moveTo', label: 'Move to' }, { key: 'set', label: 'Set there' }],
    empty: 'No Page Rules in the zones read — nothing to migrate.',
  }],
  stats: (t) => [
    { label: 'Zones with Page Rules', value: t.counts.zonesWith ?? 0, tone: t.counts.zonesWith ? 'warn' : 'ok' },
    { label: 'Settings to move', value: t.counts.settings ?? 0 },
    { label: 'Rules to create', value: t.counts.toCreate ?? 0 },
    { label: 'Page Rules that move fully', value: t.counts.movable ?? 0, tone: 'ok' },
    { label: 'Need a decision', value: t.counts.decide ?? 0, tone: t.counts.decide ? 'warn' : 'ok' },
    readStat(t, 'Zones read'),
  ],
};
