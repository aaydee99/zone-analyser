import 'server-only';
import { HttpError } from './http';
import { cfGet, cfOne, cfReason, refused } from './cf-read';
import { filteredRows } from './stored-rows';
import { tokenForZone } from './account-token';
import { MAX_ZONE_BYTES, compareZones, parseZone } from './bind-zone';
import { compareDelegation, nsSet } from './dns-hygiene';
import { dataOf, dohEnabled, resolve } from './doh';
import type { CompareView, PendingRow, WatchView } from './onboarding-types';

// Zone onboarding, read-only: a BIND file compared with what Cloudflare has for the zone now (its own
// BIND export: one API call, kept five minutes), and a zone's status and nameservers against what
// public DNS returns (one API call and one DoH lookup). The zones still waiting are listed from the
// DNS hygiene check's stored rows.

const EXPORT_TTL_MS = 5 * 60_000;
const g = globalThis as unknown as { __onboardExports?: Map<string, { until: number; text: string; name: string; accountName: string }> };
const exportsCache = (g.__onboardExports ??= new Map());

async function currentExport(zoneId: string, fresh: boolean) {
  const hit = exportsCache.get(zoneId);
  if (!fresh && hit && hit.until > Date.now()) return { ...hit, cached: true };
  const t = await tokenForZone(zoneId);
  const r = await cfGet(t.token, `/zones/${zoneId}/dns_records/export`);
  if (r.status !== 200 || r.text === undefined) throw new HttpError(refused(r) ? 403 : r.status === 404 ? 404 : 502, refused(r) ? `Cloudflare refused it: the stored token needs “Zone: DNS Read” (${cfReason(r)})` : `Cloudflare could not export the zone’s DNS (${cfReason(r)})`);
  const v = { until: Date.now() + EXPORT_TTL_MS, text: r.text, name: t.zoneName, accountName: t.accountName };
  if (exportsCache.size > 200) exportsCache.delete(exportsCache.keys().next().value!);
  exportsCache.set(zoneId, v);
  return { ...v, cached: false };
}

export async function compareFile(zoneId: string, text: string, fresh = false): Promise<CompareView> {
  if (Buffer.byteLength(text, 'utf8') > MAX_ZONE_BYTES) throw new HttpError(413, `The zone file is larger than ${MAX_ZONE_BYTES / 1024} KB`);
  if (!text.trim()) throw new HttpError(400, 'Paste or upload a zone file first');
  const cur = await currentExport(zoneId, fresh);
  const zone = cur.name || (/^\$ORIGIN\s+(\S+)/m.exec(text)?.[1] ?? '').replace(/\.$/, '');
  if (!zone) throw new HttpError(400, 'The zone’s name is not known yet: wait for monitoring to list it');
  const file = parseZone(text, zone);
  const current = parseZone(cur.text, zone);
  const diff = compareZones(file.records, current.records, zone);
  return { zoneId, zone, accountName: cur.accountName, ...diff, errors: file.errors.slice(0, 100), errorCount: file.errors.length, originInFile: file.origin, readAt: new Date(cur.until - EXPORT_TTL_MS).toISOString(), cached: cur.cached };
}

interface RawZone { id: string; name: string; status?: string; type?: string; name_servers?: string[]; vanity_name_servers?: string[]; original_name_servers?: string[] | null; original_registrar?: string | null; created_on?: string; activated_on?: string | null; paused?: boolean }

export async function watchZone(zoneId: string): Promise<WatchView> {
  const t = await tokenForZone(zoneId);
  const z = await cfOne<RawZone>(t.token, `/zones/${zoneId}`);
  const assigned = nsSet([...(z.vanity_name_servers ?? []), ...(z.name_servers ?? [])]);
  let seen: string[] = [], dnsStatus = dohEnabled() ? 'no answer' : 'lookups off';
  if (dohEnabled() && (z.type ?? 'full') === 'full') {
    const a = await resolve(z.name, 'NS');
    if (a.status === 0) { seen = nsSet(dataOf(a, 'NS')); dnsStatus = 'resolves'; } else if (a.status === 3) dnsStatus = 'NXDOMAIN'; else if (a.status === 2) dnsStatus = 'SERVFAIL';
  }
  const cmp = compareDelegation(assigned, seen);
  return {
    zoneId, zone: z.name, accountName: t.accountName, status: z.status ?? '', type: z.type ?? 'full', paused: !!z.paused,
    assigned, original: nsSet(z.original_name_servers ?? []), registrar: z.original_registrar ?? null, seen, delegation: cmp.state, missing: cmp.missing, extra: cmp.extra,
    dnsStatus, createdOn: z.created_on ?? null, activatedOn: z.activated_on ?? null, checkedAt: new Date().toISOString(),
  };
}

/** Zones not active yet (pending, moved …), as the DNS hygiene check last saw them, oldest first. */
export async function pendingZones(o: { offset: number; limit: number; account?: string }): Promise<{ rows: PendingRow[]; total: number }> {
  const { rows, total } = await filteredRows<Record<string, unknown>>('dns', 'zones', { ...o, statusNot: 'active' });
  return {
    rows: rows.map((d) => ({
      zoneId: String(d.zoneId ?? ''), zone: String(d.zone ?? ''), account: String(d.account ?? ''), status: String(d.status ?? ''), delegation: String(d.delegation ?? ''),
      assigned: String(d.assigned ?? ''), seen: String(d.seen ?? ''), createdOn: typeof d.createdOn === 'string' ? d.createdOn : null,
    })),
    total,
  };
}
