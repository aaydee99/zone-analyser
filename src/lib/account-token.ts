import 'server-only';
import { HttpError } from './http';
import { db } from './supabase';
import { credentialForRun, listCredentialOptions } from './vault';
import { tokenAccounts } from './providers';

// The stored token to read one account or zone with, for pages that read Cloudflare on demand
// (list items, the onboarding check). Accounts come from each credential's account list (cached five
// minutes in providers.ts); a zone's account from monitoring's targets, so the full zone list is
// never fetched for this. The token never leaves the server.

export async function tokenForAccount(accountId: string): Promise<string> {
  for (const o of (await listCredentialOptions()).filter((x) => x.kind === 'cloudflare')) {
    try {
      const c = await credentialForRun(o.id, 'cloudflare');
      if (!c.fields.apiToken) continue;
      if ((await tokenAccounts(c)).some((a) => a.id === accountId)) return c.fields.apiToken;
    } catch { /* this credential cannot be read: try the next */ }
  }
  throw new HttpError(404, 'No stored credential reads that account');
}

/** The zone's name and account as monitoring knows them, or null when monitoring has not listed it. */
export async function knownZone(zoneId: string): Promise<{ zoneId: string; zoneName: string; accountId: string; accountName: string } | null> {
  const { data } = await db().from('monitor_targets').select('scope_id, zone_name, account_id, account_name').eq('scope_kind', 'zone').eq('scope_id', zoneId).limit(1);
  const r = (data ?? [])[0] as { scope_id: string; zone_name: string | null; account_id: string | null; account_name: string | null } | undefined;
  return r?.account_id ? { zoneId, zoneName: r.zone_name ?? '', accountId: r.account_id, accountName: r.account_name ?? '' } : null;
}

/** A token that reads the zone: its account's, else the Zone explorer's lookup (which may list every zone). */
export async function tokenForZone(zoneId: string): Promise<{ token: string; zoneName: string; accountId: string; accountName: string }> {
  const z = await knownZone(zoneId);
  if (z) return { token: await tokenForAccount(z.accountId), zoneName: z.zoneName, accountId: z.accountId, accountName: z.accountName };
  const { zoneToken } = await import('./zone-explorer');
  const t = await zoneToken(zoneId);
  return { token: t.token, zoneName: t.zone.name, accountId: t.zone.accountId, accountName: t.zone.accountName };
}
