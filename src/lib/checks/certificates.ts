import 'server-only';
import { cfList, inParallel } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row, Severity } from '../monitor-types';
import { Problems, daysUntil, notAvailable, report, severityStats, type CheckRunner } from './common';

// Every certificate the tokens can read, with its days left and validation state:
// edge certificate packs, custom hostnames (SSL for SaaS), Origin CA, client certificates (per zone)
// and mTLS certificates (per account). Managed packs renew themselves, so they are flagged only when
// renewal is clearly late (7 days left); certificates someone uploads or issues are flagged at 30.

interface Pack { id: string; type?: string; status?: string; hosts?: string[]; certificate_authority?: string; certificates?: { expires_on?: string; status?: string }[]; validation_errors?: { message?: string }[] }
interface Hostname { id: string; hostname: string; status?: string; ssl?: { status?: string; expires_on?: string; validation_errors?: { message?: string }[] }; verification_errors?: string[] }
interface OriginCert { id: string; hostnames?: string[]; expires_on?: string; request_type?: string }
interface ClientCert { id: string; common_name?: string; expires_on?: string; status?: string; certificate_authority?: { name?: string } }
interface MtlsCert { id: string; name?: string; expires_on?: string; ca?: boolean; issuer?: string }

const MANAGED = new Set(['universal', 'advanced', 'total_tls', 'sni_custom_managed']);

function expirySeverity(days: number | null, managed: boolean): Severity | null {
  if (days === null) return null;
  if (days < 0) return 'critical';
  if (days <= 7) return 'high';
  if (!managed && days <= 30) return 'medium';
  return null;
}

const tone = (days: number | null, status: string): Row['_tone'] => {
  if (days !== null && days < 0) return 'bad';
  if (/expired|timed_out|revoked|deleted|error/.test(status)) return 'bad';
  if ((days !== null && days <= 30) || /pending/.test(status)) return 'warn';
  return 'ok';
};

const earliest = (dates: (string | undefined)[]) => dates.filter((d): d is string => !!d && Number.isFinite(Date.parse(d))).sort()[0] ?? null;

export const certificates: CheckRunner = async (ctx) => {
  const started = Date.now();
  const p = new Problems();
  const [{ zones, problems: zp }, { accounts, problems: ap }] = await Promise.all([ctx.zones(), ctx.accounts()]);
  p.list.push(...zp, ...ap);
  const rows: Row[] = [];
  const findings: NewFinding[] = [];
  const read = new Set<string>();
  ctx.progress.total = zones.length + accounts.length;

  const add = (f: Omit<NewFinding, 'severity'> & { severity: Severity | null }) => { if (f.severity) findings.push(f as NewFinding); };

  await inParallel(zones, 3, async (z) => {
    const scope = { zoneId: z.zoneId, zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
    let all = true;
    const list = async <T,>(path: string, what: string): Promise<T[]> => {
      try { return await cfList<T>(z.token, path, { perPage: 50, signal: ctx.signal }); } catch (err) {
        // A product the zone does not have (custom hostnames, client certificates) is simply empty.
        if (!notAvailable(err)) { all = false; p.add(`${z.zoneName} · ${what}`, err); }
        return [];
      }
    };
    const [packs, hosts, origin, client] = await Promise.all([
      list<Pack>(`/zones/${z.zoneId}/ssl/certificate_packs?status=all`, 'edge certificates'),
      list<Hostname>(`/zones/${z.zoneId}/custom_hostnames`, 'custom hostnames'),
      list<OriginCert>(`/certificates?zone_id=${z.zoneId}`, 'Origin CA certificates'),
      list<ClientCert>(`/zones/${z.zoneId}/client_certificates`, 'client certificates'),
    ]);
    for (const c of packs) {
      const expires = earliest((c.certificates ?? []).map((x) => x.expires_on));
      const days = daysUntil(expires);
      const status = c.status ?? '';
      const managed = MANAGED.has(c.type ?? '');
      const hostsText = (c.hosts ?? []).join(', ');
      rows.push({ kind: `Edge · ${(c.type ?? '').replace(/_/g, ' ')}`, name: hostsText, where: z.zoneName, status, expires, days, issuer: c.certificate_authority ?? '', _tone: tone(days, status) });
      add({ key: `pack:${z.zoneId}:${c.id}:expiry`, severity: expirySeverity(days, managed), title: days !== null && days < 0 ? `Edge certificate expired: ${hostsText}` : `Edge certificate expires in ${days} days: ${hostsText}`, detail: managed ? 'Cloudflare renews this certificate itself; renewal looks stuck — check its validation records.' : 'Renew or replace it before it expires.', ...scope });
      if (/timed_out|expired|deleted/.test(status) || c.validation_errors?.length) {
        add({ key: `pack:${z.zoneId}:${c.id}:status`, severity: 'high', title: `Edge certificate ${status.replace(/_/g, ' ') || 'has validation errors'}: ${hostsText}`, detail: (c.validation_errors ?? []).map((e) => e.message).filter(Boolean).join('; '), ...scope });
      } else if (/pending/.test(status)) {
        add({ key: `pack:${z.zoneId}:${c.id}:status`, severity: 'medium', title: `Edge certificate is ${status.replace(/_/g, ' ')}: ${hostsText}`, detail: 'It is not serving traffic until validation completes.', ...scope });
      }
    }
    for (const h of hosts) {
      const status = h.ssl?.status ?? h.status ?? '';
      const days = daysUntil(h.ssl?.expires_on);
      rows.push({ kind: 'Custom hostname', name: h.hostname, where: z.zoneName, status, expires: h.ssl?.expires_on ?? null, days, issuer: '', _tone: tone(days, status) });
      if (status && status !== 'active') {
        add({ key: `host:${z.zoneId}:${h.id}`, severity: /timed_out|expired|deleted/.test(status) ? 'high' : 'medium', title: `Custom hostname certificate is ${status.replace(/_/g, ' ')}: ${h.hostname}`, detail: [...(h.ssl?.validation_errors ?? []).map((e) => e.message), ...(h.verification_errors ?? [])].filter(Boolean).join('; '), ...scope });
      }
      add({ key: `host:${z.zoneId}:${h.id}:expiry`, severity: expirySeverity(days, false), title: `Custom hostname certificate expires in ${days} days: ${h.hostname}`, detail: 'This is an uploaded certificate: upload its replacement before it expires.', ...scope });
    }
    for (const c of origin) {
      const days = daysUntil(c.expires_on);
      const names = (c.hostnames ?? []).join(', ');
      rows.push({ kind: 'Origin CA', name: names, where: z.zoneName, status: days !== null && days < 0 ? 'expired' : 'active', expires: c.expires_on ?? null, days, issuer: 'Cloudflare Origin CA', _tone: tone(days, '') });
      add({ key: `origin:${c.id}`, severity: expirySeverity(days, false), title: days !== null && days < 0 ? `Origin CA certificate expired: ${names}` : `Origin CA certificate expires in ${days} days: ${names}`, detail: 'Your origin servers present this certificate to Cloudflare; with Full (strict) SSL, an expired one breaks the site.', ...scope });
    }
    for (const c of client) {
      const days = daysUntil(c.expires_on);
      const status = c.status ?? '';
      rows.push({ kind: 'Client (mTLS)', name: c.common_name ?? c.id, where: z.zoneName, status, expires: c.expires_on ?? null, days, issuer: c.certificate_authority?.name ?? '', _tone: tone(days, status) });
      if (status === 'active') add({ key: `client:${z.zoneId}:${c.id}`, severity: expirySeverity(days, false), title: `Client certificate expires in ${days} days: ${c.common_name ?? c.id}`, detail: 'Devices using it will be refused once it expires.', ...scope });
    }
    if (all) read.add(z.zoneId);
    ctx.progress.done++;
  });

  for (const a of accounts) {
    try {
      for (const c of await cfList<MtlsCert>(a.token, `/accounts/${a.accountId}/mtls_certificates`, { signal: ctx.signal })) {
        const days = daysUntil(c.expires_on);
        rows.push({ kind: c.ca ? 'mTLS CA' : 'mTLS', name: c.name ?? c.id, where: a.accountName || a.accountId, status: days !== null && days < 0 ? 'expired' : 'active', expires: c.expires_on ?? null, days, issuer: c.issuer ?? '', _tone: tone(days, '') });
        add({ key: `mtls:${a.accountId}:${c.id}`, severity: expirySeverity(days, false), title: days !== null && days < 0 ? `mTLS certificate expired: ${c.name ?? c.id}` : `mTLS certificate expires in ${days} days: ${c.name ?? c.id}`, detail: 'Used by Workers, Access or API Shield to check clients.', accountId: a.accountId, accountName: a.accountName });
      }
      read.add(a.accountId);
    } catch (err) {
      if (notAvailable(err)) read.add(a.accountId); else p.add(`${a.accountName || a.accountId} · mTLS certificates`, err);
    }
    ctx.progress.done++;
  }

  rows.sort((x, y) => (x.days === null ? 1e9 : Number(x.days)) - (y.days === null ? 1e9 : Number(y.days)));
  const soon = rows.filter((r) => r.days !== null && Number(r.days) >= 0 && Number(r.days) <= 30).length;
  const expired = rows.filter((r) => r.days !== null && Number(r.days) < 0).length;
  return {
    report: report('certificates', started, [
      { label: 'Certificates', value: rows.length },
      { label: 'Expired', value: expired, tone: expired ? 'bad' : 'ok' },
      { label: 'Expire within 30 days', value: soon, tone: soon ? 'warn' : 'ok' },
      ...severityStats(findings).slice(1),
    ], [{
      key: 'certificates', title: 'All certificates', description: 'Soonest to expire first. Managed edge certificates renew themselves about 30 days before they expire.',
      columns: [{ key: 'kind', label: 'Kind' }, { key: 'name', label: 'Hosts / name', kind: 'mono' }, { key: 'where', label: 'Zone or account' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'expires', label: 'Expires', kind: 'date' }, { key: 'days', label: 'Days left', kind: 'days' }, { key: 'issuer', label: 'Issuer' }],
      rows, empty: 'No certificates were found in the zones and accounts the tokens can read.',
    }], p.list, p.partial),
    findings, read,
  };
};
