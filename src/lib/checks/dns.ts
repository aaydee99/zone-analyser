import 'server-only';
import { cfList, cfOne } from '../cf-read';
import { db } from '../supabase';
import { Lookups, dataOf, dohEnabled } from '../doh';
import { compareDelegation, compareDnssec, inZone, nsSet, originLeaks, takeoverService, type DnsRecord } from '../dns-hygiene';
import type { NewFinding } from '../monitor-store';
import type { Row, Severity } from '../monitor-types';
import { DAY, Problems, SEV_SORT, daysSince, notAvailable, readStat, type CheckDef } from './common';

// DNS hygiene, once a day per zone: CNAMEs pointing at names that no longer exist (on services where
// someone else could claim them), whether public DNS delegates the zone to the nameservers Cloudflare
// assigned, whether the DS record at the parent matches the zone's DNSSEC, and unproxied records that
// give away the origin behind proxied ones. Three API calls a zone (its details, its DNS records with
// their proxy status, and DNSSEC — skipped when drift's snapshot from the last two days says it is
// off); the rest are public DNS lookups over DoH to 1.1.1.1 (src/lib/doh.ts), not API calls.
// CNAME targets are looked up a few dozen per run and remembered for a week (the unit's state), so a
// zone with thousands of them is covered over a few runs instead of in one burst.

interface Zone { id: string; name: string; status?: string; type?: string; name_servers?: string[]; vanity_name_servers?: string[]; original_name_servers?: string[] | null; created_on?: string; activated_on?: string | null; paused?: boolean }
interface Dnssec { status?: string; key_tag?: number | null; ds?: string | null }
interface Rec { id: string; name: string; type: string; content: string; proxied?: boolean; proxiable?: boolean; ttl?: number }

/** Public lookups per zone and run; answers already cached are free. */
const LOOKUPS_PER_RUN = 60;
/** A CNAME target's answer is trusted this long before it is looked up again. */
const TARGET_FRESH_MS = 7 * DAY;
/** Targets remembered per zone (state). */
const MAX_TARGETS = 5_000;
/** Rows of one kind kept per zone (a zone with thousands of leaks still shows the first ones and the count). */
const MAX_ROWS = 200;
/** Days a zone may stay pending before it is a finding. */
const PENDING_DAYS = 3;

interface TargetState { s: number; at: string }
interface State { targets?: Record<string, TargetState> }

/** The newest drift snapshot's DNSSEC status for the zone, when it is recent (null otherwise). */
async function snapshotDnssec(zoneId: string): Promise<string | null> {
  try {
    const { data } = await db().from('monitor_snapshots').select('taken_at, dnssec:data->dnssec').eq('zone_id', zoneId).eq('kind', 'latest').maybeSingle();
    const row = data as { taken_at?: string; dnssec?: unknown } | null;
    if (!row || typeof row.dnssec !== 'string' || (daysSince(row.taken_at) ?? 99) > 2) return null;
    return row.dnssec;
  } catch { return null; }
}

const status = (s: number) => (s === 0 ? 'resolves' : s === 3 ? 'NXDOMAIN' : s === 2 ? 'SERVFAIL' : s === -1 ? 'no answer' : `RCODE ${s}`);

export const dns: CheckDef = {
  id: 'dns', main: 'zone', stateful: ['zone'],
  units: {
    zone: async (z, ctx) => {
      const p = new Problems();
      const scope = { zoneId: z.id, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
      const findings: NewFinding[] = [];
      const issues: Row[] = [];
      const issue = (severity: Severity, area: string, name: string, detail: string, key: string, title: string) => {
        if (issues.length < MAX_ROWS * 2) issues.push({ severity, zone: z.zoneName, area, name, detail, _sort: SEV_SORT[severity] });
        findings.push({ key: `dns:${z.id}:${key}`, severity, title, detail, ...scope });
      };
      const zone = await cfOne<Zone>(z.token, `/zones/${z.id}`, ctx.signal);
      const name = zone.name || z.zoneName;
      const full = (zone.type ?? 'full') === 'full';

      let records: Rec[] = [];
      try { records = await cfList<Rec>(z.token, `/zones/${z.id}/dns_records`, { perPage: 5_000, max: 50_000, signal: ctx.signal }); } catch (err) { p.skip('DNS records', err); }

      // DNSSEC: drift's recent snapshot when it says off (nothing to compare a key with), else Cloudflare.
      let dnssec: string | null = await snapshotDnssec(z.id);
      let keyTag: number | null = null;
      if (dnssec === null || (dnssec !== '' && dnssec !== 'disabled')) {
        try { const d = await cfOne<Dnssec>(z.token, `/zones/${z.id}/dnssec`, ctx.signal); dnssec = d.status ?? ''; keyTag = typeof d.key_tag === 'number' ? d.key_tag : null; } catch (err) { if (notAvailable(err)) dnssec = ''; else { p.skip('DNSSEC', err); dnssec = null; } }
      }

      const look = new Lookups(LOOKUPS_PER_RUN);
      const doh = dohEnabled();

      // ── Delegation ──
      const assigned = nsSet([...(zone.vanity_name_servers ?? []), ...(zone.name_servers ?? [])]);
      let seen: string[] = [];
      let delegation = 'not checked';
      if (full && doh && zone.status !== 'deleted') {
        const a = await look.resolve(name, 'NS');
        if (a && a.status === 0) seen = nsSet(dataOf(a, 'NS'));
        else if (a && a.status === 3) delegation = 'NXDOMAIN';
        if (seen.length) {
          const cmp = compareDelegation(assigned, seen);
          delegation = cmp.state;
          const pub = seen.join(', ');
          if (cmp.state === 'elsewhere' && zone.status === 'active') issue('high', 'Delegation', name, `Public DNS returns ${pub}; Cloudflare assigned ${assigned.join(', ')}.`, 'ns:elsewhere', `${name} is not delegated to Cloudflare any more`);
          else if (cmp.state === 'extra') issue('medium', 'Delegation', name, `Delegated to ${cmp.extra.join(', ')} next to Cloudflare’s nameservers: some resolvers get answers from the other provider.`, 'ns:extra', `${name} is also delegated to other nameservers`);
          else if (cmp.state === 'missing' && zone.status === 'active') issue('low', 'Delegation', name, `Not delegated to ${cmp.missing.join(', ')}.`, 'ns:missing', `${name} is delegated to only some of its Cloudflare nameservers`);
        } else if (delegation === 'NXDOMAIN' && zone.status === 'active') {
          issue('high', 'Delegation', name, 'Public DNS says the domain does not exist: it may have expired at the registrar.', 'ns:nxdomain', `${name} does not resolve in public DNS`);
        }
      } else if (!full) delegation = `${zone.type} setup`;
      if (zone.status === 'pending' || zone.status === 'initializing') {
        const days = daysSince(zone.created_on) ?? 0;
        if (days >= PENDING_DAYS) issue('medium', 'Delegation', name, `Added ${days} days ago and still ${zone.status}: set the nameservers at the registrar to ${assigned.join(', ') || 'the ones Cloudflare assigned'}.`, 'pending', `${name} has been pending for ${days} days`);
      } else if (zone.status === 'moved') {
        issue('high', 'Delegation', name, 'Cloudflare saw the nameservers move away: the zone no longer serves traffic and is deleted after a while.', 'moved', `${name} moved away from Cloudflare`);
      }

      // ── DNSSEC against the DS at the parent ──
      let ds: string[] | null = null;
      if (full && doh && dnssec !== null) {
        const a = await look.resolve(name, 'DS');
        if (a && (a.status === 0 || a.status === 3)) ds = dataOf(a, 'DS');
      }
      const sec = compareDnssec(dnssec, keyTag, ds);
      if (sec === 'broken-disabled') issue('critical', 'DNSSEC', name, 'The registrar publishes a DS record but DNSSEC is off on Cloudflare: resolvers that validate DNSSEC (most public ones) fail to resolve the zone. Remove the DS at the registrar, or turn DNSSEC back on.', 'dnssec:broken', `DNSSEC is off but the DS is still at the registrar for ${name}`);
      else if (sec === 'mismatch') issue('high', 'DNSSEC', name, `The DS at the parent (key tag ${ds!.map((d) => d.split(/\s+/)[0]).join(', ')}) does not match Cloudflare’s key (${keyTag}): validating resolvers fail the zone.`, 'dnssec:mismatch', `The DS record for ${name} does not match its DNSSEC key`);
      else if (sec === 'no-ds' && zone.status === 'active') issue('low', 'DNSSEC', name, 'DNSSEC is on in Cloudflare, but the registrar has no DS record, so nothing is protected. Add the DS from the DNSSEC page at the registrar.', 'dnssec:nods', `DNSSEC is on but not at the registrar for ${name}`);

      // ── CNAMEs to names that are gone ──
      const old = ((ctx.state as State | null)?.targets ?? {}) as Record<string, TargetState>;
      const targets: Record<string, TargetState> = {};
      const cnames = records.filter((r) => r.type === 'CNAME' && r.content && !inZone(r.content, name));
      const unique = [...new Set(cnames.map((r) => r.content.toLowerCase().replace(/\.$/, '')))];
      // Takeover-prone first, then the oldest answers.
      unique.sort((a, b) => Number(!takeoverService(a)) - Number(!takeoverService(b)) || Date.parse(old[a]?.at ?? '1970') - Date.parse(old[b]?.at ?? '1970'));
      let unchecked = 0;
      for (const t of unique) {
        const prev = old[t];
        if (prev && Date.now() - Date.parse(prev.at) < TARGET_FRESH_MS) { targets[t] = prev; continue; }
        const a = doh ? await look.resolve(t, 'A') : null;
        if (a && a.status !== -1) targets[t] = { s: a.status, at: new Date().toISOString() };
        else { unchecked++; if (prev) targets[t] = prev; }
        if (Object.keys(targets).length >= MAX_TARGETS) break;
      }
      const prone: Row[] = [];
      let dangling = 0;
      const seenTarget = new Set<string>();
      for (const r of cnames) {
        const t = r.content.toLowerCase().replace(/\.$/, '');
        const svc = takeoverService(t);
        const st = targets[t];
        if (svc && prone.length < MAX_ROWS) prone.push({ zone: z.zoneName, name: r.name, target: t, service: svc.service, proxied: !!r.proxied, resolves: st ? status(st.s) : 'not checked yet', _tone: st?.s === 3 ? 'bad' : st ? 'ok' : 'warn', _sort: st?.s === 3 ? 0 : st ? 2 : 1 });
        if (st?.s !== 3) continue;
        dangling++;
        if (seenTarget.has(`${r.name}`)) continue;
        seenTarget.add(r.name);
        const sev: Severity = svc ? (svc.mode === 'nxdomain' ? 'critical' : 'high') : 'medium';
        issue(sev, 'Dangling CNAME', r.name, svc
          ? `Points at ${t} on ${svc.service}, which does not exist any more: anyone who creates that ${svc.service} resource serves content on ${r.name}. Delete the record, or recreate the resource.`
          : `Points at ${t}, which does not exist: if its domain can be registered, whoever registers it controls ${r.name}.`,
        `cname:${r.name.toLowerCase()}`, `${r.name} points at a name that does not exist (${t})`);
      }

      // ── Unproxied records that give away the origin ──
      const leaks = originLeaks(records as DnsRecord[]);
      const leakRows: Row[] = [];
      const leakGroups = new Map<string, number>();
      for (const l of leaks) {
        leakGroups.set(l.why, (leakGroups.get(l.why) ?? 0) + 1);
        if (leakRows.length < MAX_ROWS) {
          const sev: Severity = l.why === 'same-target' ? 'low' : 'medium';
          leakRows.push({ severity: sev, zone: z.zoneName, area: 'Origin exposure', name: `${l.record.name} ${l.record.type}`, detail: l.why === 'same-name' ? `Unproxied ${l.record.type} ${l.record.content} next to a proxied ${l.proxied.type} on the same name` : `Unproxied, same ${l.why === 'same-ip' ? 'address' : 'target'} as proxied ${l.proxied.name} (${l.record.content})`, _sort: SEV_SORT[sev] });
        }
      }
      for (const [why, n] of leakGroups) {
        const ex = leaks.filter((l) => l.why === why).slice(0, 3).map((l) => `${l.record.name} → ${l.record.content}`).join('; ');
        findings.push({
          key: `dns:${z.id}:leak:${why}`, severity: why === 'same-target' ? 'low' : 'medium', ...scope,
          title: why === 'same-name' ? `${n} unproxied record${n === 1 ? '' : 's'} on proxied names in ${z.zoneName}` : `${n} unproxied record${n === 1 ? '' : 's'} expose${n === 1 ? 's' : ''} the origin of proxied names in ${z.zoneName}`,
          detail: `Anyone can look these up and reach the origin without going through Cloudflare (WAF, DDoS protection). Proxy them, or move the origin to an address not in DNS. ${ex}${n > 3 ? ' …' : ''}`,
        });
      }

      const proxiedCount = records.filter((r) => r.proxied).length;
      const zoneRow: Row = {
        zoneId: z.id, accountId: z.accountId, zone: name, account: z.accountName, status: zone.status ?? '', type: zone.type ?? '',
        assigned: assigned.join(' '), seen: seen.join(' ') || (doh ? '' : 'lookups off'), delegation,
        dnssec: dnssec ?? 'not read', ds: ds === null ? 'not checked' : ds.length ? `${ds.length} DS` : 'none', dnssecState: sec,
        records: records.length, proxied: proxiedCount, cnames: unique.length, dangling, leaks: leaks.length, createdOn: zone.created_on ?? null,
        _tone: findings.some((f) => f.severity === 'critical' || f.severity === 'high') ? 'bad' : findings.length ? 'warn' : 'ok',
      };
      zoneRow._sort = zoneRow._tone === 'bad' ? 0 : zoneRow._tone === 'warn' ? 1 : 2;
      const problems = [...p.list, ...(!doh ? ['Public DNS lookups are off (DNS_HEALTH_DOH=off): delegation, DS and CNAME targets are not checked'] : [])];
      return {
        rows: { issues: [...issues, ...leakRows].sort((a, b) => Number(a._sort) - Number(b._sort)), cnames: prone, zones: [zoneRow] },
        findings, complete: p.complete, problems, state: { targets } satisfies State,
        // Targets left for the next run: soon, while their earlier answers are still cached.
        dueInHours: unchecked ? 1 : undefined,
        counts: {
          zones: 1, records: records.length, dangling, leaks: leaks.length, pending: zone.status === 'pending' ? 1 : 0,
          delegation: findings.filter((f) => f.key.includes(':ns:') || f.key.endsWith(':moved')).length ? 1 : 0,
          dnssec: sec === 'broken-disabled' || sec === 'mismatch' ? 1 : 0, lookups: look.used,
        },
      };
    },
  },
  sections: [
    { key: 'issues', title: 'Problems', description: 'Worst first: dangling CNAMEs, delegation, DNSSEC and unproxied records that expose an origin.',
      columns: [{ key: 'severity', label: 'Severity', kind: 'severity' }, { key: 'zone', label: 'Zone' }, { key: 'area', label: 'Area' }, { key: 'name', label: 'Name', kind: 'mono' }, { key: 'detail', label: 'Detail' }],
      empty: 'No DNS problems found.' },
    { key: 'cnames', title: 'CNAMEs on takeover-prone services', description: 'Azure, AWS, Heroku, GitHub Pages, Fastly, Shopify, Netlify, Vercel and others. Several of these answer for every name, so “resolves” does not prove the resource still exists — check the ones you no longer use.',
      columns: [{ key: 'zone', label: 'Zone' }, { key: 'name', label: 'Name', kind: 'mono' }, { key: 'target', label: 'Target', kind: 'mono' }, { key: 'service', label: 'Service' }, { key: 'proxied', label: 'Proxied', kind: 'bool' }, { key: 'resolves', label: 'Public DNS', kind: 'status' }],
      empty: 'No CNAMEs point at takeover-prone services.' },
    { key: 'zones', title: 'Zones', description: 'Nameservers Cloudflare assigned against what public DNS returns, and DNSSEC against the DS at the parent.',
      columns: [{ key: 'zone', label: 'Zone' }, { key: 'account', label: 'Account' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'delegation', label: 'Delegation' }, { key: 'seen', label: 'Public NS', kind: 'mono' }, { key: 'dnssec', label: 'DNSSEC' }, { key: 'ds', label: 'DS at parent' }, { key: 'records', label: 'Records', kind: 'number' }, { key: 'leaks', label: 'Exposed', kind: 'number' }],
      empty: 'No zones read yet.' },
  ],
  stats: (t) => [
    { label: 'Dangling CNAMEs', value: t.counts.dangling ?? 0, tone: t.counts.dangling ? 'bad' : 'ok' },
    { label: 'Exposed origins', value: t.counts.leaks ?? 0, tone: t.counts.leaks ? 'warn' : 'ok' },
    { label: 'Delegation or DNSSEC problems', value: (t.counts.delegation ?? 0) + (t.counts.dnssec ?? 0), tone: (t.counts.delegation ?? 0) + (t.counts.dnssec ?? 0) ? 'warn' : 'ok' },
    readStat(t, 'Zones read'),
  ],
};
