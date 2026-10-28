import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeDay, type ScannedSession } from '../src/shared/ledger.ts';
import { allPeriodTotals, dailyTotals, periodStart, sessionRows } from '../src/shared/stats.ts';
import type { HistoryData, PackSnapshot, TokenBucket } from '../src/shared/types.ts';

const bucket = (input: number, output = 0): TokenBucket => ({ input, output, cacheRead: 10, cacheWrite: 0, messages: 1, costUsd: 0 });
const scan = (rows: Array<[string, number, string?]>): Map<string, ScannedSession> =>
  new Map(rows.map(([id, n, model = 'opus']) => [`claude:${id}`, { client: 'claude', sessionId: id, byModel: { [model]: bucket(n) } }]));

// Wednesday 2026-10-28
const NOW = new Date(2026, 9, 28, 15).getTime();

function snapshot(): PackSnapshot {
  const days: HistoryData['days'] = {};
  const add = (date: string, rows: Array<[string, number, string?]>) => (days[date] = mergeDay(undefined, date, scan(rows), 0).day);
  add('2026-09-30', [['old', 1000]]);
  add('2026-10-05', [['a', 100]]);
  add('2026-10-26', [['b', 20], ['a', 5, 'sonnet']]); // Monday this week
  add('2026-10-27', [['b', 30]]);
  // a session whose logs were cleaned up
  days['2026-10-05'] = mergeDay(days['2026-10-05'], '2026-10-05', new Map(), 1).day;
  return {
    packId: 'claude',
    today: { schema: 1, date: '2026-10-28', sessions: mergeDay(undefined, '2026-10-28', scan([['c', 7]]), 0).day.sessions, total: bucket(7), lastActivityAt: null, scannedAt: NOW, scannedWith: null },
    history: { schema: 1, days, verifiedThrough: '2026-10-27', verifiedWith: null, lateCheckedOn: null, updatedAt: 0 },
    quota: null,
    status: null,
  };
}

test('period starts: today, Monday of this week, the 1st of the month, none for total', () => {
  assert.equal(periodStart('today', '2026-10-28'), '2026-10-28');
  assert.equal(periodStart('week', '2026-10-28'), '2026-10-26');
  assert.equal(periodStart('week', '2026-10-26'), '2026-10-26'); // Monday itself
  assert.equal(periodStart('week', '2026-11-01'), '2026-10-26'); // Sunday belongs to the week that began Monday
  assert.equal(periodStart('month', '2026-10-28'), '2026-10-01');
  assert.equal(periodStart('total', '2026-10-28'), null);
});

test('totals per period combine the ledger and today', () => {
  const t = allPeriodTotals(snapshot(), NOW);
  assert.deepEqual([t.today.active, t.week.active, t.month.active, t.total.active], [7, 62, 162, 1162]);
  assert.deepEqual([t.today.sessions, t.week.sessions, t.month.sessions, t.total.sessions], [1, 3, 3, 4]);
  assert.equal(t.week.cacheRead, 40); // 4 session-days × 10
});

test('session rows sum a session over its days, list its models, flag retained data, sort by usage', () => {
  const rows = sessionRows(snapshot(), 'month', NOW);
  assert.deepEqual(rows.map((r) => [r.sessionId, r.usage.active]), [['a', 105], ['b', 50], ['c', 7]]);
  const a = rows[0]!;
  assert.equal(a.firstDate, '2026-10-05');
  assert.equal(a.lastDate, '2026-10-26');
  assert.deepEqual(a.models, ['opus', 'sonnet']);
  assert.equal(a.retained, true);
  assert.equal(rows[1]!.retained, false);
  assert.deepEqual(sessionRows(snapshot(), 'today', NOW).map((r) => r.sessionId), ['c']);
  assert.equal(sessionRows(snapshot(), 'total', NOW)[0]!.sessionId, 'old');
});

test('a stale today.json from a past day is not counted as today', () => {
  const s = snapshot();
  s.today = { ...s.today!, date: '2026-10-27' };
  assert.equal(allPeriodTotals(s, NOW).today.active, 0);
});

test('daily totals: active tokens per day, oldest first, today included', () => {
  assert.deepEqual(dailyTotals(snapshot(), NOW), [
    { date: '2026-09-30', active: 1000 },
    { date: '2026-10-05', active: 100 },
    { date: '2026-10-26', active: 25 },
    { date: '2026-10-27', active: 30 },
    { date: '2026-10-28', active: 7 },
  ]);
});
