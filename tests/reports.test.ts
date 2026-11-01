import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeLabel, cleanDefinition, emptyCounts, fmtEastern, headlineOf, nextRunAt, scheduleLabel, type ReportContent } from '@/lib/report-types';
import { reportHtml, sectionCsv, sectionLines, slackEscape, slackMessage } from '@/lib/report-render';

const at = (s: string) => new Date(s);

// Eastern time, daylight saving included. In 2026 EDT ends on 1 November; in 2027 it starts on 14 March.
test('daily reports run at the given Eastern hour, today or tomorrow, across daylight-saving changes', () => {
  assert.equal(nextRunAt('daily', 7, null, at('2026-10-31T10:59:00Z')).toISOString(), '2026-10-31T11:00:00.000Z'); // 07:00 EDT
  assert.equal(nextRunAt('daily', 7, null, at('2026-10-31T11:00:00Z')).toISOString(), '2026-11-01T12:00:00.000Z'); // 07:00 EST, the day EDT ends
  assert.equal(nextRunAt('daily', 0, null, at('2026-12-31T23:30:00Z')).toISOString(), '2027-01-01T05:00:00.000Z'); // midnight EST
  assert.equal(nextRunAt('daily', 7, null, at('2027-03-13T12:30:00Z')).toISOString(), '2027-03-14T11:00:00.000Z'); // 07:00 EDT, the day EDT starts
});

test('weekly reports run on their Eastern weekday, a week later once that time has passed', () => {
  // 2026-10-31 is a Saturday.
  assert.equal(nextRunAt('weekly', 9, 1, at('2026-10-31T16:00:00Z')).toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(nextRunAt('weekly', 9, 6, at('2026-10-31T12:00:00Z')).toISOString(), '2026-10-31T13:00:00.000Z');
  assert.equal(nextRunAt('weekly', 9, 6, at('2026-10-31T13:00:00Z')).toISOString(), '2026-11-07T14:00:00.000Z');
  // Sunday 23:30 EST is already Monday in UTC: still this coming Monday at 09:00 Eastern.
  assert.equal(nextRunAt('weekly', 9, 1, at('2026-11-02T04:30:00Z')).toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(scheduleLabel({ cadence: 'weekly', hour: 9, weekday: 1 }), 'Every Monday at 09:00 Eastern (EST/EDT)');
});

test('times are shown in Eastern time with EST or EDT', () => {
  assert.equal(fmtEastern('2026-10-31T11:00:00Z'), '2026-10-31 07:00 EDT');
  assert.equal(fmtEastern('2026-11-02T14:00:00Z'), '2026-11-02 09:00 EST');
});

test('report settings are checked and cleaned', () => {
  const ok = cleanDefinition({ name: '  Weekly\nsummary ', scope: 'tag', tags: 'Env:Prod, team:payments env:prod', cadence: 'weekly', weekday: 2, hour: 6, sections: ['coverage', 'findings'], channels: ['webhook', 'slack', 'slack'] });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.name, 'Weekly summary');
    assert.deepEqual(ok.value.tags, ['env:prod', 'team:payments']);
    assert.deepEqual(ok.value.sections, ['findings', 'coverage']);
    assert.deepEqual(ok.value.channels, ['slack', 'webhook']);
    assert.deepEqual(ok.value.accounts, []);
  }
  const daily = cleanDefinition({ name: 'x', cadence: 'daily', weekday: 3 });
  assert.ok(daily.ok && daily.value.weekday === null && daily.value.sections.length === 5 && daily.value.channels.length === 0);
  for (const bad of [{ name: '' }, { name: 'x', scope: 'accounts', accounts: [] }, { name: 'x', scope: 'accounts', accounts: ['nope'] }, { name: 'x', hour: 24 },
    { name: 'x', cadence: 'monthly' }, { name: 'x', sections: ['secrets'] }, { name: 'x', sections: [] }, { name: 'x', channels: ['email'] }, { name: 'x', scope: 'tag', tags: ['bad tag!'] }]) {
    assert.equal(cleanDefinition(bad).ok, false, JSON.stringify(bad));
  }
});

test('a change is only shown against a real earlier number', () => {
  assert.equal(changeLabel(110, 100), '+10.0%');
  assert.equal(changeLabel(90, 100), '−10.0%');
  assert.equal(changeLabel(5, 0), 'new');
  assert.equal(changeLabel(0, 0), '0%');
  assert.equal(changeLabel(5, null), '');
});

const content = (): ReportContent => ({
  version: 1, name: 'Ops <weekly>', cadence: 'weekly', scope: { kind: 'all', label: 'All zones and accounts' },
  generatedAt: '2026-10-31T07:00:00.000Z', periodStart: '2026-10-24T07:00:00.000Z', periodEnd: '2026-10-31T07:00:00.000Z', since: '2026-10-24T07:00:00.000Z',
  sections: {
    changes: { status: 'nothing', total: 0, byCategory: [], top: [], zoneEvents: { added: 0, activated: 0, removed: 0 }, problems: [], readAt: null },
    findings: {
      status: 'ok', open: { ...emptyCounts(), high: 2 }, fresh: { ...emptyCounts(), high: 1 }, resolved: emptyCounts(),
      freshTop: [{ severity: 'high', check: 'Certificates', title: '=HYPERLINK("http://198.51.100.9") <script>', where: 'Acme › example.com', at: '2026-10-30T10:00:00.000Z' }], resolvedTop: [],
    },
    traffic: { status: 'unavailable', note: 'the token cannot read analytics', read: 0, of: 2, unit: 'accounts', current: null, previous: null, security: null, securityPrevious: null, problems: [] },
    certificates: { status: 'nothing', total: 0, rows: [] },
  },
});

test('empty sections say nothing, unreadable ones say why — no numbers are made up', () => {
  const c = content();
  assert.deepEqual(sectionLines(c, 'changes'), ['Nothing changed.']);
  assert.deepEqual(sectionLines(c, 'certificates'), ['Nothing expires within 30 days.']);
  assert.match(sectionLines(c, 'traffic')[0], /^Not available: the token cannot read analytics/);
  assert.equal(sectionLines(c, 'coverage').length, 0);
  assert.match(headlineOf(c) ?? '', /2 open findings \(1 new\)/);
});

test('report text is escaped for Slack, HTML and spreadsheets', () => {
  const c = content();
  const slack = slackMessage(c, 'Castellan', 'https://console.example.com/console/reports/runs/1').text;
  assert.ok(slack.includes('Ops &lt;weekly&gt;') && !slack.includes('<weekly>'));
  assert.ok(slack.endsWith('<https://console.example.com/console/reports/runs/1|Open the report>'));
  assert.equal(slackEscape('a & <b>'), 'a &amp; &lt;b&gt;');
  const html = reportHtml(c, 'Castellan');
  assert.ok(html.includes('&lt;script&gt;') && !/<script/i.test(html));
  const csv = sectionCsv(c, 'findings')!;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://198.51.100.9"") <script>"`), csv);
  assert.equal(sectionCsv(c, 'coverage'), null);
});
