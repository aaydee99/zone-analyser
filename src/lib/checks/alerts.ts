import 'server-only';
import { cfList, cfOne } from '../cf-read';
import { listAlerts } from '../monitor-store';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { Problems, daysSince, report, type CheckRunner } from './common';

// Cloudflare's own notifications, per account: the policies that are on, the alert types the account
// could turn on but has not (from Cloudflare's catalog, so the list fits each account's plan), webhook
// destinations that are failing, and the alerts Cloudflare delivered to this console.

interface Policy { id: string; name?: string; alert_type?: string; enabled?: boolean; mechanisms?: Record<string, unknown[]>; filters?: { zones?: string[] } }
interface Available { type?: string; display_name?: string; description?: string }
interface Webhook { id: string; name?: string; url?: string; type?: string; last_success?: string | null; last_failure?: string | null }

/** Alert types worth having on wherever they are offered: certificates, attacks, health and outages. */
const RECOMMENDED = /ssl|certificate|expir|ddos|dos_attack|health|tunnel|security_insights|origin_error|logpush|incident|hijack|leak|secondary_dns|failing/i;

export const alerts: CheckRunner = async (ctx) => {
  const started = Date.now();
  const p = new Problems();
  const { accounts, problems } = await ctx.accounts();
  p.list.push(...problems);
  const policyRows: Row[] = [];
  const missingRows: Row[] = [];
  const hookRows: Row[] = [];
  const findings: NewFinding[] = [];
  const read = new Set<string>();
  ctx.progress.total = accounts.length;
  for (const a of accounts) {
    const scope = { accountId: a.accountId, accountName: a.accountName || a.accountId };
    try {
      const [policies, catalog, hooks] = await Promise.all([
        cfList<Policy>(a.token, `/accounts/${a.accountId}/alerting/v3/policies`, { perPage: 0, signal: ctx.signal }),
        cfOne<Record<string, Available[]>>(a.token, `/accounts/${a.accountId}/alerting/v3/available_alerts`, ctx.signal),
        cfList<Webhook>(a.token, `/accounts/${a.accountId}/alerting/v3/destinations/webhooks`, { perPage: 0, signal: ctx.signal }).catch(() => [] as Webhook[]),
      ]);
      read.add(a.accountId);
      const on = new Set(policies.filter((x) => x.enabled).map((x) => x.alert_type ?? ''));
      for (const x of policies) {
        const mech = Object.entries(x.mechanisms ?? {}).filter(([, v]) => Array.isArray(v) && v.length).map(([k]) => k).join(', ');
        policyRows.push({ name: x.name ?? x.id, account: scope.accountName, type: x.alert_type ?? '', enabled: !!x.enabled, sendsTo: mech || '—', zones: x.filters?.zones?.length ? `${x.filters.zones.length} zone(s)` : 'All', _tone: x.enabled ? 'ok' : 'warn' });
      }
      const missing: string[] = [];
      for (const [category, types] of Object.entries(catalog ?? {})) {
        for (const t of Array.isArray(types) ? types : []) {
          if (!t.type || on.has(t.type)) continue;
          const rec = RECOMMENDED.test(t.type) || RECOMMENDED.test(t.display_name ?? '');
          if (rec) missing.push(t.display_name ?? t.type);
          missingRows.push({ account: scope.accountName, category, alert: t.display_name ?? t.type, type: t.type, recommended: rec, about: t.description ?? '' });
        }
      }
      if (missing.length) {
        findings.push({ key: `${a.accountId}:missing`, severity: 'low', title: `${missing.length} recommended Cloudflare alert${missing.length === 1 ? ' is' : 's are'} off in ${scope.accountName}`, detail: missing.slice(0, 12).join(', ') + (missing.length > 12 ? '…' : ''), ...scope });
      }
      for (const h of hooks) {
        const failing = !!h.last_failure && (!h.last_success || h.last_failure > h.last_success);
        hookRows.push({ name: h.name ?? h.id, account: scope.accountName, type: h.type ?? '', lastSuccess: h.last_success ?? null, lastFailure: h.last_failure ?? null, status: failing ? 'failing' : h.last_success ? 'working' : 'never used', _tone: failing ? 'bad' : 'ok' });
        if (failing && (daysSince(h.last_failure) ?? 99) <= 7) {
          findings.push({ key: `${a.accountId}:hook:${h.id}`, severity: 'medium', title: `Cloudflare cannot deliver alerts to “${h.name ?? h.id}”`, detail: `Last failure ${h.last_failure}${h.last_success ? `, last success ${h.last_success}` : ', never succeeded'}.`, ...scope });
        }
      }
    } catch (err) {
      p.add(scope.accountName, err);
    }
    ctx.progress.done++;
  }
  const received = await listAlerts(100).catch(() => []);
  const recentRows: Row[] = received.map((r) => ({ received: r.receivedAt, name: r.name ?? r.alertType ?? 'Alert', type: r.alertType ?? '', text: r.text ?? '' }));
  missingRows.sort((x, y) => Number(y.recommended) - Number(x.recommended));
  const rec = missingRows.filter((r) => r.recommended).length;
  return {
    report: report('alerts', started, [
      { label: 'Alert policies', value: policyRows.length },
      { label: 'Recommended, off', value: rec, tone: rec ? 'warn' : 'ok' },
      { label: 'Failing destinations', value: hookRows.filter((r) => r.status === 'failing').length, tone: hookRows.some((r) => r.status === 'failing') ? 'bad' : 'ok' },
      { label: 'Alerts received', value: recentRows.length },
    ], [
      { key: 'received', title: 'Alerts Cloudflare sent to this console', description: 'Newest first. Connect an account below to receive them.', columns: [{ key: 'received', label: 'Received', kind: 'date' }, { key: 'name', label: 'Alert' }, { key: 'type', label: 'Type', kind: 'mono' }, { key: 'text', label: 'Message' }], rows: recentRows, empty: 'No alerts received yet.' },
      { key: 'policies', title: 'Notifications that are set up', columns: [{ key: 'name', label: 'Name' }, { key: 'account', label: 'Account' }, { key: 'type', label: 'Alert type', kind: 'mono' }, { key: 'enabled', label: 'On', kind: 'bool' }, { key: 'sendsTo', label: 'Sends to' }, { key: 'zones', label: 'Zones' }], rows: policyRows, empty: 'No notification policies in the accounts read.' },
      { key: 'missing', title: 'Alerts that are off', description: 'Every alert type Cloudflare offers each account that no policy uses. Recommended ones cover certificates, attacks, health and outages.', columns: [{ key: 'recommended', label: 'Recommended', kind: 'bool' }, { key: 'alert', label: 'Alert' }, { key: 'category', label: 'Category' }, { key: 'account', label: 'Account' }, { key: 'about', label: 'What it does' }], rows: missingRows, empty: 'Every alert type is in use.' },
      { key: 'webhooks', title: 'Webhook destinations', columns: [{ key: 'name', label: 'Name' }, { key: 'account', label: 'Account' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'lastSuccess', label: 'Last success', kind: 'date' }, { key: 'lastFailure', label: 'Last failure', kind: 'date' }], rows: hookRows, empty: 'No webhook destinations.' },
    ], p.list, p.partial),
    findings, read,
  };
};
