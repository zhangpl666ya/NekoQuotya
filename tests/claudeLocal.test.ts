import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claudeLocalSource, readDesktopSample, readTokenExpiry, type DesktopSample, type LocalQuotaSource } from '../src/collector/claudeLocal.ts';
import { DESKTOP_STALE_MS, Scheduler } from '../src/collector/scheduler.ts';
import type { Runner, TokscaleRequest, TokscaleResult } from '../src/collector/tokscaleRunner.ts';
import { PackManifestSchema } from '../src/shared/packs/manifest.ts';
import type { LoadedPack } from '../src/shared/packs/registry.ts';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'neko-claude-'));
const MIN = 60_000;
const T0 = Date.parse('2026-10-31T03:00:00Z');

// ---- file readers --------------------------------------------------------------

test('desktop samples: the newest sample with values, version 2 only', () => {
  const dir = tmp();
  const file = path.join(dir, 'plan-usage-history.json');
  writeFileSync(file, JSON.stringify({
    version: 2,
    samples: [
      { t: 1, org: 'o', u: { fh: 10, sd: 20 } },
      { t: 2, org: 'o', u: { fh: 66, sd: 26 } },
      { t: 3, org: 'o' }, // no values: skipped
    ],
  }));
  assert.deepEqual(readDesktopSample(file), { at: 2, session: 66, weekly: 26 });

  writeFileSync(file, JSON.stringify({ version: 3, samples: [{ t: 1, u: { fh: 1, sd: 1 } }] }));
  assert.equal(readDesktopSample(file), null);
  writeFileSync(file, 'not json');
  assert.equal(readDesktopSample(file), null);
  assert.equal(readDesktopSample(path.join(dir, 'missing.json')), null);
});

test('credentials: only the expiry time is read', () => {
  const dir = tmp();
  const file = path.join(dir, '.credentials.json');
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'secret', refreshToken: 'secret', expiresAt: 1234 } }));
  assert.equal(readTokenExpiry(file), 1234);
  writeFileSync(file, JSON.stringify({ other: {} }));
  assert.equal(readTokenExpiry(file), null);
  assert.equal(readTokenExpiry(path.join(dir, 'missing.json')), null);
});

test('source: picks the newest sample across install folders', () => {
  const dir = tmp();
  const write = (name: string, t: number, fh: number) => {
    mkdirSync(path.join(dir, name), { recursive: true });
    const file = path.join(dir, name, 'plan-usage-history.json');
    writeFileSync(file, JSON.stringify({ version: 2, samples: [{ t, u: { fh, sd: 1 } }] }));
    return file;
  };
  const files = [write('a', 5, 50), write('b', 9, 90)];
  const source = claudeLocalSource({ usageFiles: () => files, credentialsFile: path.join(dir, 'none') });
  assert.equal(source.desktopSample()?.session, 90);
  assert.equal(source.tokenExpiresAt(), null);
});

// ---- scheduler -----------------------------------------------------------------

function makePack(): LoadedPack {
  const dir = tmp();
  const manifest = PackManifestSchema.parse({
    id: 'claude', name: 'Claude', version: 1, packFormat: 1,
    source: { tokscaleClients: ['claude'], quotaProvider: 'Claude' },
  });
  return { id: 'claude', dir, dataDir: path.join(dir, 'data'), manifest, watchRoots: [] };
}

const claudeUsage = (resetsAt: string) => JSON.stringify([
  { provider: 'Claude', plan: 'Pro', metrics: [{ label: 'Session', used_percent: 40, resets_at: resetsAt }, { label: 'Weekly', used_percent: 20, resets_at: null }] },
]);
const codexOnly = JSON.stringify([{ provider: 'Codex', plan: 'Plus', metrics: [] }]);

class UsageRunner implements Runner {
  usage = codexOnly;
  usageCalls = 0;
  async run(req: TokscaleRequest): Promise<TokscaleResult> {
    if (req.kind === 'usage') this.usageCalls++;
    return { stdout: req.kind === 'usage' ? this.usage : '', warnings: [], durationMs: 1 };
  }
  async dispose() {}
}

class FakeSource implements LocalQuotaSource {
  sample: DesktopSample | null = null;
  expiresAt: number | null = null;
  version = 0;
  fingerprint = () => String(this.version);
  desktopSample = () => this.sample;
  tokenExpiresAt = () => this.expiresAt;
}

function setup() {
  let clock = T0;
  const runner = new UsageRunner();
  const source = new FakeSource();
  const scheduler = new Scheduler({ packs: [makePack()], runner, watch: false, now: () => clock, localQuota: { Claude: source } });
  return { runner, source, scheduler, quota: () => scheduler.snapshot('claude')!.quota!, advance: (ms: number) => (clock += ms), now: () => clock };
}

test('desktop sample covers a missing tokscale result, keeping a reset time that has not passed', async () => {
  const { runner, source, scheduler, quota, advance, now } = setup();
  runner.usage = claudeUsage(new Date(T0 + 120 * MIN).toISOString());
  await scheduler.refreshQuota();
  assert.equal(quota().source, 'tokscale');

  advance(20 * MIN);
  runner.usage = codexOnly;
  source.expiresAt = now() - MIN;
  source.sample = { at: now() - 2 * MIN, session: 55, weekly: 21 };
  await scheduler.refreshQuota();
  const q = quota();
  assert.equal(q.source, 'desktop');
  assert.equal(q.error, null);
  assert.equal(q.tokenExpired, true);
  assert.equal(q.plan, 'Pro');
  assert.deepEqual(q.windows.map((w) => [w.kind, w.usedPercent, w.stale]), [['session', 55, false], ['weekly', 21, false]]);
  assert.equal(q.windows[0]!.resetsAt, T0 + 120 * MIN);
  assert.equal(q.windows[1]!.resetsAt, null);
  // Covered: no backoff, so the other tools keep refreshing at the normal pace
  assert.equal(scheduler.nextQuotaDelay(), 15 * MIN);
});

test('an expired sign-in without desktop data reports claude_token_expired and does not back off', async () => {
  const { source, scheduler, quota, now } = setup();
  source.expiresAt = now() - MIN;
  await scheduler.refreshQuota();
  assert.deepEqual(quota().error, { code: 'claude_token_expired' });
  assert.equal(quota().tokenExpired, true);
  assert.equal(scheduler.nextQuotaDelay(), 15 * MIN);
});

test('heartbeat: a newer desktop sample is applied at once; a fresh sign-in queries again', async () => {
  const { runner, source, scheduler, quota, advance, now } = setup();
  source.expiresAt = now() - MIN;
  source.sample = { at: now() - MIN, session: 10, weekly: 5 };
  await scheduler.refreshQuota();
  assert.equal(quota().windows[0]!.usedPercent, 10);

  advance(15 * MIN);
  source.sample = { at: now(), session: 30, weekly: 6 };
  source.version++;
  await scheduler.checkLocalQuota();
  assert.equal(quota().windows[0]!.usedPercent, 30);
  await scheduler.checkLocalQuota(); // unchanged files: nothing to do
  assert.equal(runner.usageCalls, 1);

  // The user ran `claude`: the token file changed and is valid again
  source.expiresAt = now() + 8 * 60 * MIN;
  source.version++;
  runner.usage = claudeUsage(new Date(now() + 60 * MIN).toISOString());
  await scheduler.checkLocalQuota();
  assert.equal(runner.usageCalls, 2);
  assert.equal(quota().source, 'tokscale');
  assert.equal(quota().tokenExpired, false);
});

test('desktop data older than the stale limit is shown as stale', async () => {
  const { source, scheduler, quota, now } = setup();
  source.sample = { at: now() - DESKTOP_STALE_MS - MIN, session: 10, weekly: 5 };
  await scheduler.refreshQuota();
  assert.equal(quota().source, 'desktop');
  assert.ok(quota().windows.every((w) => w.stale));
});
