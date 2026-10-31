import 'server-only';
import { cfList, cfOne } from '../cf-read';
import type { NewFinding } from '../monitor-store';
import type { Row } from '../monitor-types';
import { Problems, daysSince, readStat, type CheckDef } from './common';

// The developer platform in each account: Workers, Pages projects, R2 buckets, KV namespaces, D1
// databases and queues. Read-only here; rolling a Worker or a Pages project back is an action with
// its own approval (src/lib/cf-actions.ts).

interface Script { id: string; modified_on?: string; created_on?: string; usage_model?: string; compatibility_date?: string; handlers?: string[] }
interface PagesProject { name: string; subdomain?: string; production_branch?: string; created_on?: string; latest_deployment?: { id?: string; created_on?: string; url?: string; environment?: string; latest_stage?: { name?: string; status?: string } } }
interface Bucket { name: string; creation_date?: string; location?: string; storage_class?: string }
interface Kv { id: string; title?: string }
interface D1 { uuid: string; name?: string; created_at?: string; num_tables?: number; file_size?: number }
interface Queue { queue_id: string; queue_name?: string; created_on?: string; consumers?: unknown[]; producers?: unknown[] }

export const platform: CheckDef = {
  id: 'platform', main: 'account',
  units: {
    account: async (a, ctx) => {
      const p = new Problems();
      const account = a.accountName || a.accountId;
      const scope = { accountId: a.accountId, accountName: account };
      const workers: Row[] = [], pages: Row[] = [], storage: Row[] = [];
      const findings: NewFinding[] = [];
      const list = async <T,>(path: string, what: string, opts: { perPage?: number } = {}): Promise<T[]> => {
        try { return await cfList<T>(a.token, `/accounts/${a.accountId}${path}`, { perPage: opts.perPage ?? 0, signal: ctx.signal }); } catch (err) {
          p.skip(what, err);
          return [];
        }
      };
      const [scripts, projects, buckets, kv, d1, queues] = await Promise.all([
        list<Script>('/workers/scripts', 'Workers'),
        list<PagesProject>('/pages/projects', 'Pages', { perPage: 10 }),
        // R2 answers { buckets: [...] } inside `result`.
        cfOne<{ buckets?: Bucket[] }>(a.token, `/accounts/${a.accountId}/r2/buckets?per_page=1000`, ctx.signal).then((r) => r?.buckets ?? []).catch((err) => {
          p.skip('R2', err);
          return [] as Bucket[];
        }),
        list<Kv>('/storage/kv/namespaces', 'KV', { perPage: 100 }),
        list<D1>('/d1/database', 'D1', { perPage: 100 }),
        list<Queue>('/queues', 'Queues'),
      ]);
      for (const s of scripts) {
        workers.push({ name: s.id, account, accountId: a.accountId, modified: s.modified_on ?? null, compatibility: s.compatibility_date ?? '', handlers: (s.handlers ?? []).join(', '), usage: s.usage_model ?? '' });
        const age = daysSince(s.compatibility_date);
        if (age !== null && age > 730) findings.push({ key: `worker:${a.accountId}:${s.id}:compat`, severity: 'info', title: `Worker “${s.id}” uses a compatibility date over two years old`, detail: `compatibility_date ${s.compatibility_date}: newer runtime fixes are not applied until it is raised.`, ...scope });
      }
      let failed = 0;
      for (const pr of projects) {
        const stage = pr.latest_deployment?.latest_stage;
        const bad = stage?.status === 'failure';
        if (bad) failed++;
        pages.push({ name: pr.name, account, accountId: a.accountId, domain: pr.subdomain ?? '', branch: pr.production_branch ?? '', deployed: pr.latest_deployment?.created_on ?? null, status: stage ? `${stage.name ?? ''} ${stage.status ?? ''}`.trim() : '—', _tone: bad ? 'bad' : 'ok', _sort: bad ? 0 : 1 });
        if (bad) findings.push({ key: `pages:${a.accountId}:${pr.name}:${pr.latest_deployment?.id ?? ''}`, severity: 'medium', title: `The latest deployment of Pages project “${pr.name}” failed`, detail: `Stage ${stage?.name ?? '?'} failed; the previous deployment is still live.`, ...scope });
      }
      for (const b of buckets) storage.push({ kind: 'R2 bucket', name: b.name, account, created: b.creation_date ?? null, detail: [b.location, b.storage_class].filter(Boolean).join(' · ') });
      for (const n of kv) storage.push({ kind: 'KV namespace', name: n.title ?? n.id, account, created: null, detail: n.id });
      for (const d of d1) storage.push({ kind: 'D1 database', name: d.name ?? d.uuid, account, created: d.created_at ?? null, detail: [d.num_tables !== undefined ? `${d.num_tables} tables` : '', d.file_size !== undefined ? `${Math.round(d.file_size / 1024)} KB` : ''].filter(Boolean).join(' · ') });
      for (const q of queues) storage.push({ kind: 'Queue', name: q.queue_name ?? q.queue_id, account, created: q.created_on ?? null, detail: `${q.producers?.length ?? 0} producers · ${q.consumers?.length ?? 0} consumers` });
      return { rows: { workers, pages, storage }, findings, complete: p.complete, problems: p.list, counts: { workers: workers.length, pages: pages.length, storage: storage.length, failedDeployments: failed } };
    },
  },
  sections: [
    { key: 'workers', title: 'Workers', description: 'Roll a Worker back to an earlier version from its row (an approved action).', columns: [{ key: 'name', label: 'Worker', kind: 'mono' }, { key: 'account', label: 'Account' }, { key: 'modified', label: 'Last deployed', kind: 'date' }, { key: 'compatibility', label: 'Compatibility date', kind: 'mono' }, { key: 'handlers', label: 'Handlers' }], empty: 'No Workers in the accounts read.' },
    { key: 'pages', title: 'Pages projects', columns: [{ key: 'name', label: 'Project', kind: 'mono' }, { key: 'account', label: 'Account' }, { key: 'domain', label: 'Domain', kind: 'mono' }, { key: 'branch', label: 'Branch' }, { key: 'deployed', label: 'Last deployment', kind: 'date' }, { key: 'status', label: 'Status', kind: 'status' }], empty: 'No Pages projects in the accounts read.' },
    { key: 'storage', title: 'Storage and queues', columns: [{ key: 'kind', label: 'Kind' }, { key: 'name', label: 'Name', kind: 'mono' }, { key: 'account', label: 'Account' }, { key: 'created', label: 'Created', kind: 'date' }, { key: 'detail', label: 'Detail' }], empty: 'No R2 buckets, KV namespaces, D1 databases or queues in the accounts read.' },
  ],
  stats: (t) => [
    { label: 'Workers', value: t.counts.workers ?? 0 },
    { label: 'Pages projects', value: t.counts.pages ?? 0 },
    { label: 'Failed deployments', value: t.counts.failedDeployments ?? 0, tone: t.counts.failedDeployments ? 'bad' : 'ok' },
    readStat(t, 'Accounts read'),
  ],
};
