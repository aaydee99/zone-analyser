import 'server-only';
import { cfList } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { notAvailable, readStat, type CheckDef } from './common';
import { compactNum } from '@/lib/num';

// Page Rules are being replaced by Cache, Configuration, Redirect, Origin and Transform Rules
// (developers.cloudflare.com/rules/reference/page-rules-migration). For every Page Rule still in
// use, this says what each of its settings becomes; a few have no direct replacement. A zone without
// Page Rules is looked at again once a week.

interface PageRule { id: string; status?: string; priority?: number; targets?: { constraint?: { value?: string } }[]; actions?: { id: string; value?: unknown }[]; modified_on?: string }

const CACHE = 'Cache Rules', CONFIG = 'Configuration Rules', REDIRECT = 'Redirect Rules (single redirect)', ORIGIN = 'Origin Rules', TRANSFORM = 'Transform Rules / Managed Transforms';
const TARGET: Record<string, string> = {
  forwarding_url: REDIRECT, always_use_https: `${REDIRECT} or the Always Use HTTPS setting`,
  cache_level: CACHE, edge_cache_ttl: CACHE, browser_cache_ttl: CACHE, cache_key_fields: CACHE, cache_deception_armor: CACHE, cache_on_cookie: CACHE,
  bypass_cache_on_cookie: CACHE, cache_by_device_type: CACHE, origin_cache_control: CACHE, respect_strong_etag: CACHE, explicit_cache_control: CACHE,
  cache_ttl_by_status: CACHE, sort_query_string_for_cache: CACHE, origin_error_page_pass_thru: CACHE,
  ssl: CONFIG, security_level: CONFIG, automatic_https_rewrites: CONFIG, browser_check: CONFIG, email_obfuscation: CONFIG, rocket_loader: CONFIG,
  mirage: CONFIG, polish: CONFIG, minify: CONFIG, opportunistic_encryption: CONFIG, server_side_exclude: CONFIG, automatic_platform_optimization: CONFIG,
  bic: CONFIG, hotlink_protection: CONFIG, disable_apps: CONFIG, disable_zaraz: CONFIG,
  host_header_override: ORIGIN, resolve_override: ORIGIN,
  true_client_ip_header: TRANSFORM, ip_geolocation: TRANSFORM,
};
/** Settings Cloudflare does not migrate automatically: they need a decision. */
const NO_REPLACEMENT = new Set(['disable_performance', 'disable_security', 'disable_railgun', 'response_buffering', 'waf']);

const show = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));


export const pagerules: CheckDef = {
  id: 'pagerules', main: 'zone', idleHours: 168,
  units: {
    zone: async (z, ctx) => {
      const scope = { zoneId: z.id, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
      let rules: PageRule[];
      try { rules = await cfList<PageRule>(z.token, `/zones/${z.id}/pagerules`, { perPage: 0, signal: ctx.signal }); } catch (err) {
        if (notAvailable(err)) return { rows: { rules: [] }, findings: [], complete: true, idle: true, counts: { zonesWith: 0, settings: 0, decide: 0 } };
        throw err;
      }
      const rows: Row[] = [];
      const findings: NewFinding[] = [];
      let blocked = 0;
      for (const r of rules) {
        const url = r.targets?.[0]?.constraint?.value ?? '';
        for (const a of r.actions ?? []) {
          const none = NO_REPLACEMENT.has(a.id);
          if (none) blocked++;
          rows.push({ zone: z.zoneName, url, status: r.status ?? '', setting: a.id, value: show(a.value), moveTo: none ? 'No direct replacement — decide by hand' : TARGET[a.id] ?? 'Check the migration guide', _tone: none ? 'warn' : null, _sort: none ? 0 : 1 });
        }
      }
      const active = rules.filter((r) => r.status !== 'disabled').length;
      if (active) findings.push({ key: `${z.id}:migrate`, severity: blocked ? 'medium' : 'low', title: `${active} Page Rule${active === 1 ? '' : 's'} on ${z.zoneName} to migrate`, detail: blocked ? `${compactNum(blocked)} setting${blocked === 1 ? ' has' : 's have'} no direct replacement and need a decision.` : 'Each setting has a modern rule to move to.', ...scope });
      return { rows: { rules: rows }, findings, complete: true, idle: !rules.length, counts: { zonesWith: rules.length ? 1 : 0, settings: rows.length, decide: blocked } };
    },
  },
  sections: [{
    key: 'rules', title: 'Page Rule settings and where they go', description: 'Cloudflare is moving every Page Rule setting to a modern rule type. Recreate each one there, check it, then delete the Page Rule.',
    columns: [{ key: 'zone', label: 'Zone' }, { key: 'url', label: 'URL pattern', kind: 'mono' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'setting', label: 'Setting', kind: 'mono' }, { key: 'value', label: 'Value', kind: 'mono' }, { key: 'moveTo', label: 'Move to' }],
    empty: 'No Page Rules in the zones read — nothing to migrate.',
  }],
  stats: (t) => [
    { label: 'Zones with Page Rules', value: t.counts.zonesWith ?? 0, tone: t.counts.zonesWith ? 'warn' : 'ok' },
    { label: 'Settings to move', value: t.counts.settings ?? 0 },
    { label: 'Need a decision', value: t.counts.decide ?? 0, tone: t.counts.decide ? 'warn' : 'ok' },
    readStat(t, 'Zones read'),
  ],
};
