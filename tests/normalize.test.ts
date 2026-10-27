import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cleanPlan, classifyWindow, findProvider, parseReset, reportToSessions, usageToQuota } from '../src/collector/normalize.ts';
import { SessionReportSchema, UsageSchema, parseWith } from '../src/collector/schema.ts';
import { NekoError } from '../src/shared/errors.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('sessions: keeps only the pack’s clients', () => {
  const report = parseWith(SessionReportSchema, fixture('sessions-claude.json'), 'today');
  const sessions = reportToSessions(report, ['claude']);
  assert.equal(sessions.size, 3);
  const s = sessions.get('claude:2c909139-5b96-4cb4-9161-0345e0a4bfb2')!;
  assert.equal(s.client, 'claude');
  assert.deepEqual(Object.keys(s.byModel), ['claude-opus-5-5']);
  assert.equal(s.byModel['claude-opus-5-5']!.input, 228);
  assert.equal(s.byModel['claude-opus-5-5']!.output, 147864);

  assert.equal(reportToSessions(report, ['codex']).size, 0);
});

test('sessions: reasoning is added to output; models stay separate; empty rows are dropped', () => {
  const report = parseWith(
    SessionReportSchema,
    JSON.stringify({
      entries: [
        { client: 'codex', sessionId: 's1', model: 'gpt-a', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 7, messageCount: 1, cost: 0.1 },
        { client: 'codex', sessionId: 's1', model: 'gpt-b', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 1, cost: null },
        { client: 'codex', sessionId: 's2', model: 'gpt-a', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 0, cost: 0 },
      ],
    }),
    'day'
  );
  const sessions = reportToSessions(report, ['codex']);
  assert.deepEqual([...sessions.keys()], ['codex:s1']);
  const s1 = sessions.get('codex:s1')!;
  assert.equal(s1.byModel['gpt-a']!.output, 12);
  assert.equal(s1.byModel['gpt-b']!.costUsd, 0);
});

test('quota: Claude Session/Weekly become kinds, with no display text stored', () => {
  const usage = parseWith(UsageSchema, fixture('usage.json'), 'usage');
  const claude = findProvider(usage, 'claude');
  assert.ok(claude);
  const { plan, windows } = usageToQuota(claude, Date.parse('2026-10-27T00:00:00Z'));
  assert.equal(plan, 'Pro');
  assert.deepEqual(
    windows.map((w) => [w.kind, w.rawLabel, w.usedPercent, w.applicable, w.stale]),
    [
      ['session', 'Session', 23, true, false],
      ['weekly', 'Weekly', 3, true, false],
    ]
  );
  assert.equal(windows[0]!.resetsAt, Date.parse('2026-10-27T06:30:00.534355+00:00'));
});

test('quota: windows past their reset time are stale', () => {
  const usage = parseWith(UsageSchema, fixture('usage.json'), 'usage');
  const { windows } = usageToQuota(findProvider(usage, 'Claude')!, Date.parse('2026-10-28T00:00:00Z'));
  assert.equal(windows[0]!.stale, true); // 5-hour window has passed
  assert.equal(windows[1]!.stale, false); // weekly window has not
});

test('quota: a 0/0 allowance is not applicable (Copilot Premium)', () => {
  const usage = parseWith(UsageSchema, fixture('usage.json'), 'usage');
  const { windows } = usageToQuota(findProvider(usage, 'Copilot')!, 0);
  assert.equal(windows.find((w) => w.rawLabel === 'Premium')!.applicable, false);
  assert.equal(windows.find((w) => w.rawLabel === 'Chat')!.applicable, true);
  assert.equal(windows.find((w) => w.rawLabel === 'Chat')!.kind, 'other');
});

test('window kinds and plan names', () => {
  assert.equal(classifyWindow('5h'), 'session');
  assert.equal(classifyWindow('Weekly'), 'weekly');
  assert.equal(classifyWindow('Chat'), 'other');
  assert.equal(cleanPlan('Pro ai'), 'Pro');
  assert.equal(cleanPlan('plus'), 'Plus');
  assert.equal(cleanPlan('Something Else'), 'Something Else');
  assert.equal(cleanPlan(''), null);
});

test('reset times: a bare date means local midnight', () => {
  assert.equal(parseReset('2026-11-01'), new Date(2026, 10, 1).getTime());
  assert.equal(parseReset(null), null);
  assert.equal(parseReset('not a date'), null);
});

test('malformed output raises tokscale_bad_output instead of accepting partial data', () => {
  const isBadOutput = (err: unknown) => err instanceof NekoError && err.code === 'tokscale_bad_output';
  assert.throws(() => parseWith(SessionReportSchema, '{"entries":[{"client":"claude"}]}', 'today'), isBadOutput);
  assert.throws(() => parseWith(SessionReportSchema, 'not json', 'today'), isBadOutput);
});
