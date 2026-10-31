import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterFromParams, filterToParams, isFilterEmpty, normalizeTag, parseCsv, parseTags, readMetaCsv, searchTerm } from '@/lib/zone-meta-types';
import { csvFile } from '@/lib/zone-format';

test('normalizeTag: lower case, spaces as dashes, only safe characters', () => {
  assert.equal(normalizeTag('  Team:Payments '), 'team:payments');
  assert.equal(normalizeTag('tier critical'), 'tier-critical');
  assert.equal(normalizeTag('env/prod.eu_1'), 'env/prod.eu_1');
  assert.equal(normalizeTag(':leading'), null);
  assert.equal(normalizeTag('<script>'), null);
  assert.equal(normalizeTag('a'.repeat(65)), null);
  assert.equal(normalizeTag(''), null);
});

test('parseTags: sorted, without repeats, invalid ones reported', () => {
  assert.deepEqual(parseTags('env:prod, team:payments;env:prod  tier:critical'), { tags: ['env:prod', 'team:payments', 'tier:critical'], bad: [] });
  assert.deepEqual(parseTags(['B', 'a', '%x']), { tags: ['a', 'b'], bad: ['%x'] });
  assert.deepEqual(parseTags(null), { tags: [], bad: [] });
});

test('filters round-trip through a query string', () => {
  const p = filterToParams({ tags: ['env:prod', 'team:a'], owner: 'Payments', q: 'oncall' });
  assert.equal(p.toString(), 'tags=env%3Aprod%2Cteam%3Aa&owner=Payments&mq=oncall');
  assert.deepEqual(filterFromParams(p), { tags: ['env:prod', 'team:a'], owner: 'Payments', q: 'oncall' });
  assert.ok(isFilterEmpty(filterFromParams(new URLSearchParams(''))));
  assert.equal(searchTerm('50%_off,(x)'), '50  off  x');
});

test('parseCsv: quotes, doubled quotes, CRLF, BOM, blank lines', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","say ""hi"""\n\n"multi\nline",z'), [['a', 'b'], ['x,1', 'say "hi"'], ['multi\nline', 'z']]);
});

test('readMetaCsv reads what exportCsv writes (round trip, formula guard undone)', () => {
  const file = csvFile([
    ['zone_id', 'zone_name', 'account', 'tags', 'owner', 'contact', 'notes'],
    ['023e105f4ecef8ad9ca31a8372d0c353', 'example.com', 'Acme', 'env:prod;team:payments', '=Payments', 'ops@example.com', 'line 1\nline 2'],
  ]);
  const r = readMetaCsv(file);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0], { line: 2, zoneId: '023e105f4ecef8ad9ca31a8372d0c353', zoneName: 'example.com', tags: ['env:prod', 'team:payments'], owner: '=Payments', contact: 'ops@example.com', notes: 'line 1\nline 2' });
});

test('readMetaCsv: only the columns present change; bad rows reported', () => {
  const r = readMetaCsv('Zone Name,Tags\nshop.example.test,env:prod env:prod\n,orphan\nbad.example.test,ok %bad\n');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].owner, undefined, 'no owner column: owner untouched');
  assert.deepEqual(r.rows[0].tags, ['env:prod']);
  assert.ok(r.errors.some((e) => /Line 3: no zone/.test(e)));
  assert.ok(r.errors.some((e) => /Line 4: not a tag: %bad/.test(e)));
  assert.match(readMetaCsv('foo,bar\n1,2').errors[0], /zone_id or zone_name/);
  assert.match(readMetaCsv('zone_id\nabc').errors[0], /Nothing to import/);
  assert.ok(readMetaCsv('zone_id,tags\nnot a zone!,x').errors[0].includes('is not a zone id'));
});
