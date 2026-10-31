import 'server-only';
import { cfList } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { Problems, daysSince, daysUntil, notAvailable, report, severityStats, type CheckRunner } from './common';

// Who and what can change the accounts: API tokens (the users' tokens behind each stored credential,
// GET /user/tokens, and account-owned tokens, GET /accounts/{id}/tokens) and account members
// (GET /accounts/{id}/members). Nothing secret is read: Cloudflare never returns a token's value.

interface Token {
  id: string; name?: string; status?: string; issued_on?: string; modified_on?: string; expires_on?: string | null; last_used_on?: string | null;
  condition?: { request_ip?: { in?: string[]; not_in?: string[] } };
  policies?: { effect?: string; permission_groups?: { name?: string }[] }[];
}
interface Member {
  id: string; status?: string; user?: { email?: string; two_factor_authentication_enabled?: boolean; first_name?: string | null; last_name?: string | null };
  roles?: { name?: string }[]; policies?: { permission_groups?: { name?: string }[] }[];
}

const UNUSED_DAYS = 90;
const EXPIRING_DAYS = 14;

export const governance: CheckRunner = async (ctx) => {
  const started = Date.now();
  const p = new Problems();
  const { accounts, problems } = await ctx.accounts();
  p.list.push(...problems);
  const tokenRows: Row[] = [];
  const memberRows: Row[] = [];
  const findings: NewFinding[] = [];
  const read = new Set<string>();
  const seenTokens = new Set<string>();
  const byToken = new Map<string, typeof accounts>();
  for (const a of accounts) byToken.set(a.token, [...(byToken.get(a.token) ?? []), a]);
  ctx.progress.total = byToken.size + accounts.length;
  let userTokensRefused = 0;

  const judge = (t: Token, owner: string, scope: { accountId?: string; accountName?: string }) => {
    if (seenTokens.has(t.id)) return;
    seenTokens.add(t.id);
    const expiresIn = daysUntil(t.expires_on);
    const idle = daysSince(t.last_used_on);
    const age = daysSince(t.issued_on);
    const ipLimited = !!(t.condition?.request_ip?.in?.length || t.condition?.request_ip?.not_in?.length);
    const perms = [...new Set((t.policies ?? []).flatMap((x) => (x.permission_groups ?? []).map((g) => g.name ?? '')).filter(Boolean))];
    const writes = perms.filter((n) => /write|edit/i.test(n)).length;
    const status = t.status ?? '';
    tokenRows.push({
      name: t.name ?? t.id, owner, status, permissions: perms.length ? `${perms.length} (${writes} write)` : '—',
      lastUsed: t.last_used_on ?? null, expires: t.expires_on ?? null, ip: ipLimited ? 'Restricted' : 'Any address',
      _tone: status !== 'active' ? 'warn' : expiresIn !== null && expiresIn <= EXPIRING_DAYS ? 'warn' : 'ok',
    });
    const base = { ...scope, accountName: scope.accountName ?? owner };
    if (status === 'active' && expiresIn !== null && expiresIn >= 0 && expiresIn <= EXPIRING_DAYS) {
      findings.push({ key: `token:${t.id}:expiring`, severity: 'high', title: `API token “${t.name}” expires in ${expiresIn} days`, detail: 'Anything that uses it (CI, Terraform, this console) stops working when it expires. Roll it or extend it.', ...base });
    }
    if (status === 'expired' || (expiresIn !== null && expiresIn < 0)) {
      findings.push({ key: `token:${t.id}:expired`, severity: 'low', title: `API token “${t.name}” has expired`, detail: 'Delete it if nothing needs it.', ...base });
    }
    if (status === 'active' && idle !== null && idle >= UNUSED_DAYS) {
      findings.push({ key: `token:${t.id}:unused`, severity: 'medium', title: `API token “${t.name}” has not been used for ${idle} days`, detail: 'Unused tokens are risk without benefit: delete or disable it.', ...base });
    } else if (status === 'active' && !t.last_used_on && age !== null && age >= 30) {
      findings.push({ key: `token:${t.id}:never`, severity: 'medium', title: `API token “${t.name}” was never used (created ${age} days ago)`, detail: 'Delete it if nothing needs it.', ...base });
    }
    if (status === 'active' && !ipLimited && writes > 0) {
      findings.push({ key: `token:${t.id}:ip`, severity: 'low', title: `API token “${t.name}” can write from any IP address`, detail: `It has ${writes} write permission${writes === 1 ? '' : 's'}. Limit it to the addresses that use it (Client IP Address Filtering).`, ...base });
    }
  };

  // Each stored token's own user tokens (needs "API Tokens Read" on the token).
  for (const [token, accts] of byToken) {
    try {
      for (const t of await cfList<Token>(token, '/user/tokens', { perPage: 50, signal: ctx.signal })) judge(t, 'User token', {});
    } catch (err) {
      if (notAvailable(err)) userTokensRefused++; else p.add(`User tokens (${accts[0]?.credentialName ?? 'credential'})`, err);
    }
    ctx.progress.done++;
  }

  for (const a of accounts) {
    const scope = { accountId: a.accountId, accountName: a.accountName || a.accountId };
    let ok = true;
    try {
      for (const t of await cfList<Token>(a.token, `/accounts/${a.accountId}/tokens`, { perPage: 50, signal: ctx.signal })) judge(t, `Account: ${scope.accountName}`, scope);
    } catch (err) { if (!notAvailable(err)) { ok = false; p.add(`${scope.accountName} · account tokens`, err); } }
    try {
      for (const m of await cfList<Member>(a.token, `/accounts/${a.accountId}/members`, { perPage: 50, signal: ctx.signal })) {
        const email = m.user?.email ?? m.id;
        const twoFa = m.user?.two_factor_authentication_enabled;
        const roles = [...(m.roles ?? []).map((r) => r.name ?? ''), ...(m.policies ?? []).flatMap((x) => (x.permission_groups ?? []).map((g) => g.name ?? ''))].filter(Boolean);
        memberRows.push({ email, account: scope.accountName, status: m.status ?? '', roles: [...new Set(roles)].join(', '), twoFactor: twoFa === undefined ? null : twoFa, _tone: m.status === 'accepted' && twoFa === false ? 'bad' : m.status === 'pending' ? 'warn' : 'ok' });
        if (m.status === 'accepted' && twoFa === false) {
          findings.push({ key: `member:${a.accountId}:${m.id}:2fa`, severity: 'medium', title: `${email} signs in without two-factor authentication`, detail: 'Require 2FA for the account (Manage Account › Members), or use dashboard SSO.', ...scope });
        }
        if (m.status === 'pending') {
          findings.push({ key: `member:${a.accountId}:${m.id}:pending`, severity: 'info', title: `Invitation to ${email} is still pending`, detail: 'Revoke it if it is no longer needed.', ...scope });
        }
      }
    } catch (err) { if (!notAvailable(err)) { ok = false; p.add(`${scope.accountName} · members`, err); } else p.add(`${scope.accountName} · members`, err); }
    if (ok) read.add(a.accountId);
    ctx.progress.done++;
  }
  // User tokens have no account: their old findings resolve when every token was read.
  if (!p.list.some((x) => x.scope.startsWith('User tokens'))) read.add('*');

  const noTwoFa = memberRows.filter((r) => r.twoFactor === false && r.status === 'accepted').length;
  return {
    report: report('governance', started, [
      { label: 'API tokens', value: tokenRows.length },
      { label: 'Members', value: memberRows.length },
      { label: 'Without 2FA', value: noTwoFa, tone: noTwoFa ? 'bad' : 'ok' },
      ...severityStats(findings).slice(1),
    ], [
      { key: 'tokens', title: 'API tokens', description: userTokensRefused ? `${userTokensRefused} stored token${userTokensRefused === 1 ? '' : 's'} cannot list their user’s tokens: add “User › API Tokens › Read” to see them.` : 'User tokens of the people behind the stored credentials, and account-owned tokens.',
        columns: [{ key: 'name', label: 'Token' }, { key: 'owner', label: 'Owner' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'permissions', label: 'Permissions' }, { key: 'lastUsed', label: 'Last used', kind: 'date' }, { key: 'expires', label: 'Expires', kind: 'date' }, { key: 'ip', label: 'IP addresses' }],
        rows: tokenRows, empty: 'No tokens could be listed.' },
      { key: 'members', title: 'Account members', columns: [{ key: 'email', label: 'Member', kind: 'mono' }, { key: 'account', label: 'Account' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'roles', label: 'Roles' }, { key: 'twoFactor', label: '2FA', kind: 'bool' }],
        rows: memberRows, empty: 'No members could be listed.' },
    ], p.list, p.partial),
    findings, read,
  };
};
