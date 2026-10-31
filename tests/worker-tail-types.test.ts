import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FilterError, checkFilters, reduceEvent, scrubUrl, tailMessage } from '@/lib/worker-tail-types';

test('checkFilters and the message Cloudflare gets', () => {
  const f = checkFilters({ status: ['error', 'ok'], methods: ['get', 'POST'], search: ' boom ', sampling: 0.1 });
  assert.deepEqual(f, { status: ['error', 'ok'], methods: ['GET', 'POST'], search: 'boom', sampling: 0.1 });
  const m = tailMessage(f);
  assert.equal(m.debug, false);
  assert.deepEqual(m.filters[0], { outcome: ['exception', 'exceededCpu', 'exceededMemory', 'exceededWallTime', 'scriptNotFound', 'unknown', 'ok'] });
  assert.deepEqual(m.filters.slice(1), [{ method: ['GET', 'POST'] }, { query: 'boom' }, { sampling_rate: 0.1 }]);
  assert.deepEqual(tailMessage(checkFilters({})).filters, []);
  assert.throws(() => checkFilters({ status: ['nope'] }), FilterError);
  assert.throws(() => checkFilters({ methods: ['TRACE'] }), FilterError);
  assert.throws(() => checkFilters({ sampling: 0 }), FilterError);
});

test('reduceEvent keeps the short form, without headers or client IPs', () => {
  const raw = {
    scriptName: 'api-worker', outcome: 'exception', eventTimestamp: Date.parse('2026-06-01T00:00:00Z'),
    event: { request: { url: 'https://user:pw@api.example.com/v1?id=7&token=SECRET1&api_key=SECRET2', method: 'POST', headers: { cookie: 'session=SECRET3', 'cf-connecting-ip': '203.0.113.9' }, cf: { colo: 'AMS', clientTcpRtt: 3 } }, response: { status: 500 } },
    logs: [{ message: ['hello', { a: 1 }], level: 'log', timestamp: Date.parse('2026-06-01T00:00:00Z') }],
    exceptions: [{ name: 'TypeError', message: 'x is undefined', timestamp: 1 }],
  };
  const e = reduceEvent(raw)!;
  assert.equal(e.kind, 'fetch');
  assert.equal(e.method, 'POST');
  assert.equal(e.status, 500);
  assert.equal(e.colo, 'AMS');
  assert.equal(e.logs[0].text, 'hello {"a":1}');
  assert.equal(e.exceptions[0].name, 'TypeError');
  const s = JSON.stringify(e);
  assert.ok(!/SECRET|203\.0\.113|cookie|pw@/.test(s), s);
  assert.match(e.url!, /id=7/);
  const cron = reduceEvent({ outcome: 'ok', eventTimestamp: 1, event: { cron: '*/5 * * * *', scheduledTime: 1 }, logs: [], exceptions: [] })!;
  assert.equal(cron.kind, 'scheduled');
  assert.equal(cron.trigger, '*/5 * * * *');
  assert.equal(reduceEvent('nope'), null);
  const many = reduceEvent({ outcome: 'ok', logs: Array.from({ length: 80 }, (_, i) => ({ message: [`l${i}`], level: 'log' })) })!;
  assert.equal(many.logs.length, 50);
  assert.equal(many.cut, true);
});

test('scrubUrl', () => {
  assert.equal(scrubUrl('https://a.example.com/p?q=1&session_id=abc'), 'https://a.example.com/p?q=1&session_id=••••');
});
