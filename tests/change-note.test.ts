import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkChangeNote, noteDetails, ticketHref } from '@/lib/change-note';

test('checkChangeNote: optional by default, trimmed, blanks left out', () => {
  assert.deepEqual(checkChangeNote({}), {});
  assert.deepEqual(checkChangeNote(null), {});
  assert.deepEqual(checkChangeNote({ reason: '  rotate certs  ', ticket: ' CHG-1234 ' }), { reason: 'rotate certs', ticket: 'CHG-1234' });
  assert.deepEqual(checkChangeNote({ reason: '', ticket: '' }), {});
});

test('checkChangeNote: requireReason, lengths and types', () => {
  assert.throws(() => checkChangeNote({ ticket: 'CHG-1' }, true), /reason is required/);
  assert.deepEqual(checkChangeNote({ reason: 'x' }, true), { reason: 'x' });
  assert.throws(() => checkChangeNote({ reason: 'x'.repeat(501) }), /longer than 500/);
  assert.throws(() => checkChangeNote({ ticket: 'x'.repeat(201) }), /longer than 200/);
  assert.throws(() => checkChangeNote({ reason: 5 }), /must be text/);
});

test('tickets: http(s) links or ids; other schemes refused', () => {
  assert.deepEqual(checkChangeNote({ ticket: 'https://tickets.example.com/CHG-1?x=1' }), { ticket: 'https://tickets.example.com/CHG-1?x=1' });
  assert.throws(() => checkChangeNote({ ticket: 'javascript:alert(1)' }), /http/);
  assert.throws(() => checkChangeNote({ ticket: 'ftp://example.com/x' }), /http/);
  assert.throws(() => checkChangeNote({ ticket: 'data:text/html,hi' }), /http/);
  assert.throws(() => checkChangeNote({ ticket: '<b>x</b>' }), /ticket id/);
  assert.equal(ticketHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(ticketHref('HTTP://example.com'), 'http://example.com/');
  assert.equal(ticketHref('CHG-1'), null);
  assert.equal(ticketHref('javascript:alert(1)'), null);
});

test('noteDetails: audit fields that do not clash with a rejection reason', () => {
  assert.deepEqual(noteDetails({ reason: 'why', ticket: 'T-1' }), { changeReason: 'why', ticket: 'T-1' });
  assert.deepEqual(noteDetails({}), {});
  assert.deepEqual(noteDetails(undefined), {});
});
