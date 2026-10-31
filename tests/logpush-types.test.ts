import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeError, checkChanges, diffLines, jobStatus, redactDestination, scrubText, summarizeJob } from '@/lib/logpush-types';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

test('jobStatus: off first, then failing, waiting, stale, healthy', () => {
  assert.equal(jobStatus({ enabled: false, last_error: ago(1) }, NOW), 'disabled');
  assert.equal(jobStatus({ enabled: true, last_complete: ago(2), last_error: ago(1) }, NOW), 'failing');
  assert.equal(jobStatus({ enabled: true, last_error: ago(1) }, NOW), 'failing', 'an error and never a push');
  assert.equal(jobStatus({ enabled: true, last_complete: ago(1), last_error: ago(2) }, NOW), 'healthy', 'pushed since the error');
  assert.equal(jobStatus({ enabled: true }, NOW), 'waiting');
  assert.equal(jobStatus({ enabled: true, last_complete: ago(30) }, NOW), 'stale');
  assert.equal(jobStatus({ enabled: true, last_complete: ago(30) }, NOW, 48), 'healthy');
});

test('redactDestination keeps the scheme and host only', () => {
  assert.equal(redactDestination('s3://logs-bucket/cf/{DATE}?region=us-east-1&access-key-id=AKIAEXAMPLE&secret-access-key=SECRETEXAMPLE'), 's3://logs-bucket');
  assert.equal(redactDestination('https://user:pass@logs.example.com/ingest?header_Authorization=Basic%20abc'), 'https://logs.example.com');
  assert.equal(redactDestination('azure://container/path?sv=2020&sig=SIGEXAMPLE'), 'azure://container');
  assert.equal(redactDestination('sumo://endpoint.example.test/receiver/v1/http/SECRETPATH'), 'sumo://endpoint.example.test');
  assert.equal(redactDestination('datadog://http-intake.example.test?header_DD-API-KEY=KEY'), 'datadog://http-intake.example.test');
  assert.equal(redactDestination('not a uri with secret=1'), '(hidden)');
  assert.equal(redactDestination(''), '');
});

test('scrubText cuts URLs to their host and blanks secret parameters', () => {
  const s = scrubText('PUT https://bucket.example.test/x?X-Amz-Signature=abc failed; access-key-id=AKIAEXAMPLE token=t0k sas=sv1');
  assert.ok(!/abc|AKIAEXAMPLE|t0k|sv1/.test(s), s);
  assert.match(s, /https:\/\/bucket\.example\.test/);
});

test('checkChanges accepts the editable fields and refuses the rest', () => {
  const c = checkChanges({ enabled: false, filter: '{"where":{"key":"ClientRequestHost","operator":"eq","value":"example.com"}}', max_upload_bytes: 5_000_000, max_upload_records: 0, max_upload_interval_seconds: 30, output_options: { output_type: 'ndjson', field_names: ['ClientIP'], sample_rate: 0.5 } }, 'update');
  assert.equal(c.enabled, false);
  assert.equal(c.max_upload_records, 0);
  assert.throws(() => checkChanges({ max_upload_bytes: 100 }, 'update'), ChangeError);
  assert.throws(() => checkChanges({ max_upload_interval_seconds: 301 }, 'update'), ChangeError);
  assert.throws(() => checkChanges({ filter: 'not json' }, 'update'), ChangeError);
  assert.throws(() => checkChanges({ filter: '{"x":1}' }, 'update'), /where/);
  assert.throws(() => checkChanges({ output_options: { evil: true } }, 'update'), /Unknown output option/);
  assert.throws(() => checkChanges({ dataset: 'http_requests' }, 'update'), /cannot be changed/);
  assert.throws(() => checkChanges({ id: 5 }, 'update'), /cannot be set/);
  assert.throws(() => checkChanges({ name: 'has space' }, 'update'), ChangeError);
  assert.throws(() => checkChanges({ dataset: 'http_requests' }, 'create'), /destination/);
  const n = checkChanges({ dataset: 'http_requests', destination_conf: 's3://b/p?region=us-east-1' }, 'create');
  assert.equal(n.dataset, 'http_requests');
  assert.throws(() => checkChanges({ dataset: 'http_requests', destination_conf: 'b/p' }, 'create'), /URI/);
});

test('summarizeJob and diffLines never show a destination path or key', () => {
  const before = summarizeJob({ enabled: true, destination_conf: 's3://b/old?secret-access-key=OLDSECRET' });
  const after = summarizeJob({ enabled: false, destination_conf: 's3://b2/new?secret-access-key=NEWSECRET' });
  const lines = diffLines(before, after);
  assert.deepEqual(lines, ['Enabled: on → off', 'Destination: s3://b → s3://b2']);
  assert.ok(!JSON.stringify([before, after]).includes('SECRET'));
});
