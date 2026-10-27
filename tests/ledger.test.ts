import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  daysToCatchUp,
  daysToReverify,
  emptyHistory,
  mergeDay,
  mergeSessions,
  reconcileRenames,
  summarizeDays,
  sumSessions,
  type ScannedSession,
} from '../src/shared/ledger.ts';
import type { HistoryData, TokenBucket } from '../src/shared/types.ts';

const bucket = (input: number, output = 0): TokenBucket => ({ input, output, cacheRead: 0, cacheWrite: 0, messages: 1, costUsd: 0 });

function scan(entries: Array<[string, number]>, client = 'claude'): Map<string, ScannedSession> {
  return new Map(entries.map(([id, tokens]) => [`${client}:${id}`, { client, sessionId: id, byModel: { opus: bucket(tokens) } }]));
}

const day = (date: string, entries: Array<[string, number]>, now = 0) => mergeDay(undefined, date, scan(entries), now).day;

test('merge: found sessions update, missing sessions are retained, nothing is deleted', () => {
  const first = mergeSessions({}, scan([['A', 100], ['B', 200]]), 1);
  assert.equal(sumSessions(first).total.input, 300);

  // A's logs were cleaned up; B is still there and its count was corrected to 180
  const second = mergeSessions(first, scan([['B', 180]]), 2);
  assert.deepEqual(Object.keys(second).sort(), ['claude:A', 'claude:B']);
  assert.equal(second['claude:A']!.retained, true);
  assert.equal(second['claude:A']!.byModel.opus!.input, 100);
  assert.equal(second['claude:A']!.lastSeenAt, 1);
  assert.equal(second['claude:B']!.retained, false);
  assert.equal(second['claude:B']!.byModel.opus!.input, 180);
  assert.equal(second['claude:B']!.firstSeenAt, 1);
  assert.equal(second['claude:B']!.lastSeenAt, 2);
  // Day total = retained A + updated B; it does not shrink because A was cleaned up
  assert.equal(sumSessions(second).total.input, 280);
  assert.equal(sumSessions(second).retainedSessions, 1);
});

test('merge: an empty scan does not wipe the ledger', () => {
  const sessions = mergeSessions(mergeSessions({}, scan([['A', 100], ['B', 200]]), 1), new Map(), 2);
  assert.equal(sumSessions(sessions).total.input, 300);
  assert.equal(sumSessions(sessions).retainedSessions, 2);
});

test('merge: a retained session that reappears becomes live again', () => {
  let s = mergeSessions({}, scan([['A', 100]]), 1);
  s = mergeSessions(s, new Map(), 2);
  assert.equal(s['claude:A']!.retained, true);
  s = mergeSessions(s, scan([['A', 120]]), 3);
  assert.equal(s['claude:A']!.retained, false);
  assert.equal(s['claude:A']!.byModel.opus!.input, 120);
});

test('renames: ids that changed in a tokscale upgrade replace the old ids instead of doubling', () => {
  const before = day('2026-10-20', [['old-1', 100], ['old-2', 50], ['kept', 10]]).sessions;
  const after = scan([['new-1', 100], ['new-2', 50], ['kept', 10]]);
  const { day: merged, renamed } = mergeDay({ date: '2026-10-20', scannedAt: 0, sessions: before }, '2026-10-20', after, 1, true);
  assert.equal(renamed, 2);
  assert.deepEqual(Object.keys(merged.sessions).sort(), ['claude:kept', 'claude:new-1', 'claude:new-2']);
  assert.equal(sumSessions(merged.sessions).total.input, 160);
});

test('renames: totals within 2% still count as a rename (the upgrade may also correct counts)', () => {
  const before = day('d', [['old', 1000]]).sessions;
  const scanned = scan([['new', 1015]]);
  const { renamed } = reconcileRenames(before, mergeSessions(before, scanned, 1), scanned);
  assert.equal(renamed, 1);
});

test('renames: different totals mean real cleanup plus a new session — keep both', () => {
  const before = day('d', [['gone', 100]]).sessions;
  const scanned = scan([['other', 300]]);
  const { sessions, renamed } = reconcileRenames(before, mergeSessions(before, scanned, 1), scanned);
  assert.equal(renamed, 0);
  assert.equal(sumSessions(sessions).total.input, 400);
  assert.equal(sessions['claude:gone']!.retained, true);
});

test('renames: sessions retained before the upgrade are never touched, and clients are matched separately', () => {
  let before = day('d', [['retained', 100]]).sessions;
  before = mergeSessions(before, new Map(), 1); // already retained
  before = { ...before, ...mergeSessions({}, scan([['c-old', 40]], 'codex'), 1) };
  const scanned = new Map([...scan([['claude-new', 100]]), ...scan([['c-new', 40]], 'codex')]);
  const { sessions, renamed } = reconcileRenames(before, mergeSessions(before, scanned, 2), scanned);
  assert.equal(renamed, 1); // only codex: c-old → c-new
  assert.ok(sessions['claude:retained'], 'a session retained earlier is kept');
  assert.ok(!sessions['codex:c-old']);
});

test('without rename detection, a plain merge keeps both old and new ids', () => {
  const before = day('d', [['old', 100]]);
  const { day: merged, renamed } = mergeDay(before, 'd', scan([['new', 100]]), 1);
  assert.equal(renamed, 0);
  assert.equal(sumSessions(merged.sessions).total.input, 200);
});

test('catch-up range: last N days on first run; afterwards the day after verifiedThrough to yesterday', () => {
  assert.deepEqual(daysToCatchUp(null, '2026-10-27', 3), ['2026-10-24', '2026-10-25', '2026-10-26']);

  const history: HistoryData = { ...emptyHistory(0), verifiedThrough: '2026-10-25' };
  assert.deepEqual(daysToCatchUp(history, '2026-10-27', 35), ['2026-10-26']);
  assert.deepEqual(daysToCatchUp({ ...history, verifiedThrough: '2026-10-26' }, '2026-10-27', 35), []);
  // Away for a long time: at most the last N days
  assert.deepEqual(daysToCatchUp({ ...history, verifiedThrough: '2026-01-01' }, '2026-10-27', 2), ['2026-10-25', '2026-10-26']);
  // Across a month boundary
  assert.deepEqual(daysToCatchUp({ ...history, verifiedThrough: '2026-10-30' }, '2026-11-02', 35), ['2026-10-31', '2026-11-01']);
});

test('re-verify range: every ledger date plus the last N days, never today', () => {
  const history: HistoryData = {
    ...emptyHistory(0),
    days: { '2026-01-05': day('2026-01-05', [['A', 1]]), '2026-10-26': day('2026-10-26', [['B', 1]]) },
  };
  assert.deepEqual(daysToReverify(history, '2026-10-27', 2), ['2026-01-05', '2026-10-25', '2026-10-26']);
});

test('summaries: sums per day within a range, counting retained sessions', () => {
  const day2 = mergeDay(day('2026-10-26', [['C', 10]], 1), '2026-10-26', new Map(), 2).day;
  const history: HistoryData = { ...emptyHistory(0), days: { '2026-10-26': day2, '2026-10-25': day('2026-10-25', [['A', 100], ['B', 50]]) } };
  assert.deepEqual(summarizeDays(history, '2026-10-20', '2026-10-26').map((d) => [d.date, d.total.input, d.sessions, d.retainedSessions]), [
    ['2026-10-25', 150, 2, 0],
    ['2026-10-26', 10, 1, 1],
  ]);
  assert.deepEqual(summarizeDays(history, '2026-10-26', '2026-10-26').map((d) => d.date), ['2026-10-26']);
});
