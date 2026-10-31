import 'server-only';
import { credentialForRun, listCredentialOptions } from './vault';
import { tokenAccounts } from './providers';
import { listZones, zoneToken } from './zone-explorer';

// What the monitoring checks read: every Cloudflare account and every zone the stored tokens can
// reach, each with the token that reads it. An account or zone reached by several credentials is
// read once, with the first credential that reaches it.

export interface AccountTarget { accountId: string; accountName: string; credentialName: string; token: string }
export interface ZoneTarget { zoneId: string; zoneName: string; accountId: string; accountName: string; plan: string; status: string; credentialName: string; token: string }
export interface TargetProblem { scope: string; error: string }

/** Every account the stored Cloudflare credentials reach. */
export async function accountTargets(): Promise<{ accounts: AccountTarget[]; problems: TargetProblem[] }> {
  const accounts = new Map<string, AccountTarget>();
  const problems: TargetProblem[] = [];
  const names = new Map<string, string>();
  // Account names from the zone list (a credential with a fixed account ID has no name of its own).
  try { for (const z of (await listZones()).zones) if (z.accountId && z.accountName) names.set(z.accountId, z.accountName); } catch { /* names stay blank */ }
  for (const o of (await listCredentialOptions()).filter((x) => x.kind === 'cloudflare')) {
    let token = '';
    try {
      const c = await credentialForRun(o.id, 'cloudflare');
      token = c.fields.apiToken;
      if (!token) continue;
      for (const a of await tokenAccounts(c)) {
        if (accounts.has(a.id)) continue;
        accounts.set(a.id, { accountId: a.id, accountName: a.name || names.get(a.id) || '', credentialName: o.name, token });
      }
    } catch (err) {
      problems.push({ scope: `Credential “${o.name}”`, error: err instanceof Error ? err.message : 'Could not list its accounts' });
    }
  }
  return { accounts: [...accounts.values()].sort((a, b) => a.accountName.localeCompare(b.accountName)), problems };
}

/** Every zone the stored Cloudflare credentials reach (from the Zone explorer's list). */
export async function zoneTargets(fresh = false): Promise<{ zones: ZoneTarget[]; problems: TargetProblem[] }> {
  const list = await listZones(fresh);
  const zones: ZoneTarget[] = [];
  const problems: TargetProblem[] = list.problems.map((p) => ({ scope: `Credential “${p.credential}”`, error: p.error }));
  for (const z of list.zones) {
    try {
      const { token, credential } = await zoneToken(z.id);
      zones.push({ zoneId: z.id, zoneName: z.name, accountId: z.accountId, accountName: z.accountName, plan: z.plan, status: z.status, credentialName: credential, token });
    } catch (err) {
      problems.push({ scope: z.name, error: err instanceof Error ? err.message : 'No stored token reads this zone' });
    }
  }
  return { zones, problems };
}
