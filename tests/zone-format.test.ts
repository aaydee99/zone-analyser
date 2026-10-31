import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell, csvFile, daysLeft, isExpired, leaves, pageRuleScope, ruleScope, scopeText } from '@/lib/zone-format';

test('csvCell quotes separators and neutralises spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('-x'), "'-x");
  assert.equal(csvCell('-5'), '-5', 'a negative number is left alone');
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
});

test('csvFile starts with a BOM and uses CRLF', () => {
  assert.equal(csvFile([['a', 'b'], [1, 2]]), '﻿a,b\r\n1,2\r\n');
});

test('leaves flattens objects and arrays into paths', () => {
  assert.deepEqual(leaves({ a: { b: 1 }, c: [true, 'x'], d: [], e: {} }), [
    ['a.b', 1], ['c[0]', true], ['c[1]', 'x'], ['d', '[]'], ['e', '{}'],
  ]);
});

test('daysLeft and isExpired', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(daysLeft('2026-01-11T00:00:00Z', now), 10);
  assert.equal(daysLeft('2025-12-30T00:00:00Z', now), -2);
  assert.equal(daysLeft('', now), null);
  assert.equal(daysLeft('not a date', now), null);
  assert.equal(isExpired('2025-12-31T00:00:00Z', now), true);
  assert.equal(isExpired('2026-02-01T00:00:00Z', now), false);
  assert.equal(isExpired('', now), false);
});

test('ruleScope finds the hosts a rule expression is limited to', () => {
  assert.deepEqual(ruleScope('true'), { hosts: [], patterns: [] });
  assert.deepEqual(ruleScope('(http.host eq "WWW.Example.com")'), { hosts: ['www.example.com'], patterns: [] });
  assert.deepEqual(ruleScope('http.host in {"a.example.com" "b.example.com"}'), { hosts: ['a.example.com', 'b.example.com'], patterns: [] });
  assert.deepEqual(ruleScope('http.host eq "a.example.com" and http.request.uri.path eq "/x"'), { hosts: ['a.example.com'], patterns: [] });
  // One alternative that does not limit the host makes the rule zone-wide.
  assert.deepEqual(ruleScope('http.host eq "a.example.com" or ip.src eq 1.2.3.4'), { hosts: [], patterns: [] });
  // A negated host condition excludes a host; the rule still runs everywhere else.
  assert.deepEqual(ruleScope('not http.host eq "a.example.com"'), { hosts: [], patterns: [] });
  assert.deepEqual(ruleScope('http.host wildcard "*.example.com"'), { hosts: [], patterns: ['*.example.com'] });
  assert.equal(scopeText(ruleScope('true')), 'whole zone');
});

test('pageRuleScope reads the URL target', () => {
  const rule = (value: string) => ({ targets: [{ target: 'url', constraint: { operator: 'matches', value } }] });
  assert.deepEqual(pageRuleScope(rule('lab.example.com/*'), 'example.com'), { hosts: ['lab.example.com'], patterns: [] });
  assert.deepEqual(pageRuleScope(rule('*example.com/*'), 'example.com'), { hosts: [], patterns: [] });
  assert.deepEqual(pageRuleScope(rule('https://*.example.com/x'), 'example.com'), { hosts: [], patterns: ['*.example.com'] });
});
