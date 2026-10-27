import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BACKFILL_DAYS, Scheduler, type SchedulerEvent } from '../src/collector/scheduler.ts';
import { buildArgs, parseWarnings, type Runner, type TokscaleRequest, type TokscaleResult } from '../src/collector/tokscaleRunner.ts';
import { NekoError } from '../src/shared/errors.ts';
import { emptyHistory, sumSessions } from '../src/shared/ledger.ts';
import { PackManifestSchema } from '../src/shared/packs/manifest.ts';
import type { LoadedPack } from '../src/shared/packs/registry.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function makePack(dir = mkdtempSync(path.join(os.tmpdir(), 'neko-pack-')), source: Record<string, unknown> = {}): LoadedPack {
  const manifest = PackManifestSchema.parse({
    id: 'claude',
    name: 'Claude-chan',
    version: 1,
    packFormat: 1,
    source: { tokscaleClients: ['claude'], quotaProvider: 'Claude', ...source },
  });
  return { id: 'claude', dir, dataDir: path.join(dir, 'data'), manifest, watchRoots: [] };
}

/** A per-session report: [session id, input tokens] */
function report(rows: Array<[string, number]>): string {
  return JSON.stringify({
    entries: rows.map(([sessionId, input]) => ({
      client: 'claude', sessionId, model: 'opus', input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 1, cost: 0,
    })),
  });
}

type Handler = (req: TokscaleRequest) => Promise<string> | string;

class FakeRunner implements Runner {
  calls: TokscaleRequest[] = [];
  version = '4.20.1';
  today: Array<[string, number]> = [];
  days: Record<string, Array<[string, number]>> = {};
  failDays = new Set<string>();
  handler: Handler | null;
  constructor(handler: Handler | null = null) {
    this.handler = handler;
  }
  async run(req: TokscaleRequest): Promise<TokscaleResult> {
    this.calls.push(req);
    const stdout = this.handler ? await this.handler(req) : this.respond(req);
    return { stdout, warnings: [], durationMs: 1 };
  }
  private respond(req: TokscaleRequest): string {
    switch (req.kind) {
      case 'version':
        return `tokscale ${this.version}\n`;
      case 'today':
        return report(this.today);
      case 'day':
        if (this.failDays.has(req.date)) throw new NekoError({ code: 'tokscale_timeout', params: { seconds: 30 } });
        return report(this.days[req.date] ?? []);
      case 'usage':
        return fixture('usage.json');
    }
  }
  dayCalls(): string[] {
    return this.calls.flatMap((c) => (c.kind === 'day' ? [c.date] : []));
  }
  async dispose() {}
}

const at = (date: string, hour = 15) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, hour).getTime();
};

const readHistory = (pack: LoadedPack) => JSON.parse(readFileSync(path.join(pack.dataDir, 'history.json'), 'utf8'));

async function runOnce(pack: LoadedPack, runner: FakeRunner, date: string, options: { resync?: boolean; events?: SchedulerEvent[] } = {}) {
  const scheduler = new Scheduler({ packs: [pack], runner, watch: false, now: () => at(date), onEvent: (e) => options.events?.push(e) });
  await scheduler.runOnce({ resync: options.resync });
  await scheduler.stop();
  return scheduler;
}

// ---- today -------------------------------------------------------------------

test('today: requests during a scan merge into one follow-up scan', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const runner = new FakeRunner(async () => {
    await gate;
    return report([['A', 100]]);
  });
  const scheduler = new Scheduler({ packs: [makePack()], runner, watch: false });
  const calls = [scheduler.refreshToday(['claude']), scheduler.refreshToday(['claude']), scheduler.refreshToday(['claude'])];
  release();
  await Promise.all(calls);
  // The first runs immediately; the two queued requests become one second round
  assert.equal(runner.calls.filter((c) => c.kind === 'today').length, 2);
});

test('today: growth records activity; deleting a session log does not shrink today', async () => {
  const runner = new FakeRunner();
  let clock = at('2026-10-27', 10);
  const scheduler = new Scheduler({ packs: [makePack()], runner, watch: false, now: () => clock });

  runner.today = [['A', 100]];
  await scheduler.refreshToday(['claude']);
  assert.equal(scheduler.snapshot('claude')!.today!.lastActivityAt, null); // unknown on the first run

  clock += 60_000;
  runner.today = [['A', 150], ['B', 50]];
  await scheduler.refreshToday(['claude']);
  assert.equal(scheduler.snapshot('claude')!.today!.lastActivityAt, clock);
  assert.equal(scheduler.snapshot('claude')!.today!.total.input, 200);

  clock += 60_000;
  runner.today = [['B', 50]]; // A's log was deleted
  await scheduler.refreshToday(['claude']);
  const t = scheduler.snapshot('claude')!.today!;
  assert.equal(t.total.input, 200);
  assert.equal(t.sessions['claude:A']!.retained, true);
  assert.equal(t.lastActivityAt, at('2026-10-27', 10) + 60_000); // no growth, activity time unchanged
});

// ---- history -----------------------------------------------------------------

test('history: the first run backfills 35 days and records only days with usage', async () => {
  const runner = new FakeRunner();
  runner.days = { '2026-10-20': [['A', 100], ['B', 50]], '2026-10-26': [['C', 10]] };
  const pack = makePack();
  const scheduler = await runOnce(pack, runner, '2026-10-27');

  const scanned = runner.dayCalls();
  assert.equal(scanned.length, BACKFILL_DAYS);
  assert.equal(scanned[0], '2026-09-22');
  assert.equal(scanned.at(-1), '2026-10-26');

  const history = readHistory(pack);
  assert.deepEqual(Object.keys(history.days).sort(), ['2026-10-20', '2026-10-26']);
  assert.equal(history.verifiedThrough, '2026-10-26');
  assert.equal(history.verifiedWith, '4.20.1');
  assert.equal(sumSessions(history.days['2026-10-20'].sessions).total.input, 150);
  assert.equal(scheduler.snapshot('claude')!.status!.history.sessions, 3);
});

test('history: later runs only scan newly finished days', async () => {
  const pack = makePack();
  await runOnce(pack, new FakeRunner(), '2026-10-27');

  const later = new FakeRunner();
  later.days = { '2026-10-28': [['D', 5]] };
  await runOnce(pack, later, '2026-10-29'); // opened again two days later
  assert.deepEqual(later.dayCalls(), ['2026-10-27', '2026-10-28']);
  assert.equal(readHistory(pack).verifiedThrough, '2026-10-28');
});

test('history: a failed day stops verifiedThrough just before it and is retried next time', async () => {
  const pack = makePack();
  const runner = new FakeRunner();
  runner.failDays.add('2026-10-25');
  runner.days = { '2026-10-26': [['A', 1]] };
  const scheduler = await runOnce(pack, runner, '2026-10-27');
  assert.equal(readHistory(pack).verifiedThrough, '2026-10-24');
  assert.ok(readHistory(pack).days['2026-10-26'], 'days after the failure are still recorded');
  const error = scheduler.snapshot('claude')!.status!.lastError!;
  assert.equal(error.stage, 'history');
  assert.equal(error.code, 'history_days_failed');
  assert.deepEqual(error.params, { count: 1, dates: '2026-10-25' });

  const retry = new FakeRunner();
  await runOnce(pack, retry, '2026-10-27');
  assert.deepEqual(retry.dayCalls(), ['2026-10-25', '2026-10-26']);
  assert.equal(readHistory(pack).verifiedThrough, '2026-10-26');
});

test('history: after session logs are cleaned up, re-verifying never lowers that day', async () => {
  const pack = makePack();
  const runner = new FakeRunner();
  runner.days = { '2026-10-20': [['A', 100], ['B', 50]] };
  await runOnce(pack, runner, '2026-10-27');

  const after = new FakeRunner();
  after.days = { '2026-10-20': [['B', 50]] }; // A has been cleaned up
  await runOnce(pack, after, '2026-10-27', { resync: true });
  const day = readHistory(pack).days['2026-10-20'];
  assert.equal(sumSessions(day.sessions).total.input, 150);
  assert.equal(day.sessions['claude:A'].retained, true);
  assert.equal(day.sessions['claude:B'].retained, false);
});

test('history: a tokscale upgrade re-verifies everything, including records older than 35 days', async () => {
  const pack = makePack();
  const runner = new FakeRunner();
  runner.days = { '2026-10-20': [['A', 100]] };
  await runOnce(pack, runner, '2026-10-27');

  const upgraded = new FakeRunner();
  upgraded.version = '4.21.0';
  const events: SchedulerEvent[] = [];
  await runOnce(pack, upgraded, '2026-12-27', { events }); // two months later
  const scanned = upgraded.dayCalls();
  assert.ok(scanned.includes('2026-10-20'), 'old ledger dates are re-verified too');
  assert.equal(scanned.length, BACKFILL_DAYS + 1);
  assert.equal(readHistory(pack).verifiedWith, '4.21.0');
  assert.equal(readHistory(pack).days['2026-10-20'].sessions['claude:A'].retained, true);
  assert.ok(events.some((e) => e.type === 'version_changed' && e.from === '4.20.1' && e.to === '4.21.0'));
});

test('history: sessions renamed by a tokscale upgrade are replaced, not counted twice', async () => {
  const pack = makePack();
  const runner = new FakeRunner();
  runner.days = { '2026-10-20': [['rollout-1', 100], ['rollout-2', 40]] };
  await runOnce(pack, runner, '2026-10-27');

  const upgraded = new FakeRunner();
  upgraded.version = '4.21.0';
  upgraded.days = { '2026-10-20': [['thread-1', 100], ['thread-2', 40]] }; // same usage, new id scheme
  const events: SchedulerEvent[] = [];
  await runOnce(pack, upgraded, '2026-10-27', { events });
  const day = readHistory(pack).days['2026-10-20'];
  assert.deepEqual(Object.keys(day.sessions).sort(), ['claude:thread-1', 'claude:thread-2']);
  assert.equal(sumSessions(day.sessions).total.input, 140);
  assert.ok(events.some((e) => e.type === 'sessions_renamed' && e.date === '2026-10-20' && e.count === 2));

  // A normal re-verify without an upgrade does not apply rename detection
  const plain = new FakeRunner();
  plain.version = '4.21.0';
  plain.days = { '2026-10-20': [['thread-1', 100], ['brand-new', 40]] };
  await runOnce(pack, plain, '2026-10-27', { resync: true });
  assert.equal(sumSessions(readHistory(pack).days['2026-10-20'].sessions).total.input, 180);
});

test('history: at midnight yesterday’s today.json enters the ledger first, even if its logs are already gone', async () => {
  const pack = makePack();
  let clock = at('2026-10-26', 23);
  const runner = new FakeRunner();
  runner.today = [['A', 100]];
  const scheduler = new Scheduler({ packs: [pack], runner, watch: false, now: () => clock });
  await scheduler.runOnce();

  // Past midnight; A's log is gone, so tokscale finds nothing for 10-26
  clock = at('2026-10-27', 0);
  runner.today = [];
  await scheduler.refreshToday(['claude']);
  await scheduler.syncHistory('catchup');
  await scheduler.stop();

  const day = readHistory(pack).days['2026-10-26'];
  assert.ok(day, 'yesterday’s session is in the ledger');
  assert.equal(day.sessions['claude:A'].byModel.opus.input, 100);
  assert.equal(day.sessions['claude:A'].retained, true);
  assert.equal(scheduler.snapshot('claude')!.today!.date, '2026-10-27');
});

test('history: packs with lateArrivalDays re-check the last N days once a day', async () => {
  const pack = makePack(undefined, { lateArrivalDays: 3 });
  await runOnce(pack, new FakeRunner(), '2026-10-27');

  const second = new FakeRunner();
  await runOnce(pack, second, '2026-10-28');
  assert.deepEqual(second.dayCalls(), ['2026-10-25', '2026-10-26', '2026-10-27']);

  const third = new FakeRunner(); // same day again: no repeat
  const scheduler = new Scheduler({ packs: [pack], runner: third, watch: false, now: () => at('2026-10-28', 18) });
  await scheduler.runOnce();
  await scheduler.stop();
  assert.deepEqual(third.dayCalls(), []);
});

test('history: a damaged ledger is restored from backup and collection continues', async () => {
  const pack = makePack();
  mkdirSync(path.join(pack.dataDir, 'backups'), { recursive: true });
  const backup = { ...emptyHistory(0), verifiedThrough: '2026-10-26' };
  writeFileSync(path.join(pack.dataDir, 'backups', 'history-2026-10-26.json'), JSON.stringify(backup));
  writeFileSync(path.join(pack.dataDir, 'history.json'), '{ damaged');

  const events: SchedulerEvent[] = [];
  const scheduler = await runOnce(pack, new FakeRunner(), '2026-10-27', { events });
  assert.equal(scheduler.snapshot('claude')!.status!.history.recoveredFrom, 'history-2026-10-26.json');
  assert.ok(events.some((e) => e.type === 'history_recovered'));
  assert.equal(readHistory(pack).verifiedThrough, '2026-10-26');
});

test('history: a damaged ledger without backups is never overwritten; the rest keeps working', async () => {
  const pack = makePack();
  mkdirSync(pack.dataDir, { recursive: true });
  const file = path.join(pack.dataDir, 'history.json');
  writeFileSync(file, '{ damaged');
  const runner = new FakeRunner();
  runner.today = [['A', 1]];
  const scheduler = await runOnce(pack, runner, '2026-10-27');

  assert.equal(readFileSync(file, 'utf8'), '{ damaged');
  assert.deepEqual(runner.dayCalls(), []);
  assert.equal(scheduler.snapshot('claude')!.today!.total.input, 1);
  assert.equal(scheduler.snapshot('claude')!.status!.lastError!.code, 'history_unreadable');
});

// ---- data folder lock ----------------------------------------------------------

test('lock: a pack whose data folder is held by another process is skipped and nothing is written', async () => {
  const pack = makePack();
  mkdirSync(pack.dataDir, { recursive: true });
  const child = spawn(process.execPath, [
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(path.join(pack.dataDir, '.lock'))}, JSON.stringify({pid: process.pid, host: require('os').hostname(), startedAt: Date.now()})); setInterval(() => {}, 1000);`,
  ]);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const runner = new FakeRunner();
    runner.today = [['A', 1]];
    const scheduler = await runOnce(pack, runner, '2026-10-27');
    assert.deepEqual(runner.calls.filter((c) => c.kind !== 'version'), []);
    assert.deepEqual(readdirSync(pack.dataDir), ['.lock']);
    const error = scheduler.snapshot('claude')!.status!.lastError!;
    assert.equal(error.code, 'data_locked');
    assert.equal(error.params?.pid, child.pid);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
});

// ---- quota -------------------------------------------------------------------

test('quota: a failure keeps the previous values as stale and backs off 1→2→5→10 minutes', async () => {
  let fail = false;
  const runner = new FakeRunner((req) => {
    if (req.kind !== 'usage') return req.kind === 'version' ? 'tokscale 4.20.1' : report([]);
    if (fail) throw new NekoError({ code: 'tokscale_timeout', params: { seconds: 20 } });
    return fixture('usage.json');
  });
  const pack = makePack();
  const scheduler = new Scheduler({ packs: [pack], runner, watch: false, now: () => Date.parse('2026-10-27T00:00:00Z') });

  await scheduler.refreshQuota();
  const ok = scheduler.snapshot('claude')!.quota!;
  assert.equal(ok.error, null);
  assert.deepEqual(ok.windows.map((w) => [w.usedPercent, w.stale]), [[23, false], [3, false]]);

  fail = true;
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    await scheduler.refreshQuota();
    delays.push(scheduler.nextQuotaDelay());
  }
  const failed = scheduler.snapshot('claude')!.quota!;
  assert.deepEqual(failed.error, { code: 'tokscale_timeout', params: { seconds: 20 } });
  assert.deepEqual(failed.windows.map((w) => [w.usedPercent, w.stale]), [[23, true], [3, true]]);
  assert.equal(failed.observedAt, ok.observedAt);
  assert.deepEqual(delays, [60_000, 120_000, 300_000, 600_000, 600_000]);
  assert.equal(JSON.parse(readFileSync(path.join(pack.dataDir, 'quota.json'), 'utf8')).windows[0].stale, true);

  fail = false;
  await scheduler.refreshQuota();
  assert.equal(scheduler.snapshot('claude')!.quota!.error, null);
  assert.equal(scheduler.snapshot('claude')!.status!.lastError, null);
});

test('quota: tokscale returning no quota for the provider is a per-pack error', async () => {
  const runner = new FakeRunner((req) => (req.kind === 'usage' ? JSON.stringify([{ provider: 'Codex', plan: 'Plus', metrics: [] }]) : ''));
  const scheduler = new Scheduler({ packs: [makePack()], runner, watch: false });
  await scheduler.refreshQuota();
  assert.deepEqual(scheduler.snapshot('claude')!.quota!.error, { code: 'quota_provider_missing', params: { provider: 'Claude' } });
});

// ---- manual refresh and fallback -----------------------------------------------

test('manual refresh: today, history catch-up and quota at once; quota skips the backoff', async () => {
  let failUsage = true;
  const runner = new FakeRunner((req) => {
    if (req.kind === 'version') return 'tokscale 4.20.1';
    if (req.kind === 'usage') {
      if (failUsage) throw new NekoError({ code: 'tokscale_timeout', params: { seconds: 20 } });
      return fixture('usage.json');
    }
    return report([['A', 1]]);
  });
  const scheduler = new Scheduler({ packs: [makePack()], runner, watch: false, now: () => at('2026-10-27') });
  await scheduler.runOnce();
  assert.equal(scheduler.nextQuotaDelay(), 60_000); // failed once, backing off

  failUsage = false;
  runner.calls = [];
  await scheduler.refreshNow();
  assert.deepEqual([...new Set(runner.calls.map((c) => c.kind))], ['today', 'usage']); // history already verified to yesterday
  assert.equal(scheduler.snapshot('claude')!.quota!.error, null);
  assert.equal(scheduler.nextQuotaDelay(), 600_000); // backoff cleared
  await scheduler.stop();
});

test('fallback: today is rescanned periodically even without any file change', async () => {
  const runner = new FakeRunner();
  const scheduler = new Scheduler({
    packs: [makePack()],
    runner,
    watch: false,
    intervals: { tickMs: 50, todayFallbackMs: 100, quotaIdleMs: 60_000 },
  });
  await scheduler.start();
  const before = runner.calls.filter((c) => c.kind === 'today').length;
  await new Promise((r) => setTimeout(r, 400));
  await scheduler.stop();
  const after = runner.calls.filter((c) => c.kind === 'today').length;
  assert.ok(after - before >= 2, `expected at least 2 fallback scans in 400 ms, got ${after - before}`);
});

// ---- tokscale arguments --------------------------------------------------------

test('tokscale arguments: only allowed commands can be built; clients and dates are validated', () => {
  assert.deepEqual(buildArgs({ kind: 'today', clients: ['codex', 'claude', 'claude'] }), [
    '--json', '--today', '--client', 'claude,codex', '--group-by', 'client,session,model', '--no-spinner',
  ]);
  assert.deepEqual(buildArgs({ kind: 'day', clients: ['claude'], date: '2026-10-21' }, '/tmp/home'), [
    '--json', '--since', '2026-10-21', '--until', '2026-10-21', '--client', 'claude',
    '--group-by', 'client,session,model', '--home', '/tmp/home', '--no-spinner',
  ]);
  assert.deepEqual(buildArgs({ kind: 'usage' }, '/tmp/home'), ['usage', '--json']);
  assert.throws(() => buildArgs({ kind: 'today', clients: ['claude;submit'] }), /invalid client id/);
  assert.throws(() => buildArgs({ kind: 'today', clients: [] }), /at least one client/);
  assert.throws(() => buildArgs({ kind: 'day', clients: ['claude'], date: '2026/1/1' }), /YYYY-MM-DD/);
});

test('hints are extracted from stderr', () => {
  const stderr = [
    'tokscale: some usage is partial, unpriced, or has stale pricing',
    '',
    'Warning: 3 of 122 inspected rollout files contain Codex activity',
    'progress 50%',
  ].join('\n');
  assert.deepEqual(parseWarnings(stderr), [
    'some usage is partial, unpriced, or has stale pricing',
    '3 of 122 inspected rollout files contain Codex activity',
  ]);
});
