import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePressure, stepMood, type BrainRules } from '../src/main/brain/mood.ts';
import { ACTION_MS, PetBrain } from '../src/main/brain/petBrain.ts';
import { PackManifestSchema } from '../src/shared/packs/manifest.ts';
import type { PackSnapshot, QuotaWindow } from '../src/shared/types.ts';
import { emptyBucket } from '../src/shared/usage.ts';

const MIN = 60_000;
const T0 = new Date(2026, 9, 27, 10).getTime();

function rules(behavior: Record<string, unknown> = {}): BrainRules {
  return PackManifestSchema.parse({
    id: 'claude', name: 'Claude-chan', version: 1, packFormat: 1,
    source: { tokscaleClients: ['claude'] },
    behavior: { chatterMinutes: null, ...behavior },
  }).behavior;
}

function win(kind: QuotaWindow['kind'], usedPercent: number, extra: Partial<QuotaWindow> = {}): QuotaWindow {
  return { kind, rawLabel: kind, usedPercent, resetsAt: null, applicable: true, stale: false, ...extra };
}

/** A snapshot with today's active tokens, last activity time and quota windows */
function snap(opts: { tokens?: number; activityAt?: number | null; windows?: QuotaWindow[]; error?: boolean; date?: string } = {}): PackSnapshot {
  const total = { ...emptyBucket(), input: opts.tokens ?? 0 };
  return {
    packId: 'claude',
    today: { schema: 1, date: opts.date ?? '2026-10-27', sessions: {}, total, lastActivityAt: opts.activityAt ?? null, scannedAt: T0, scannedWith: '4.20.1' },
    history: null,
    quota: opts.windows
      ? { schema: 1, provider: 'Claude', plan: 'Pro', windows: opts.windows, observedAt: T0, lastAttemptAt: T0, error: opts.error ? { code: 'tokscale_timeout' } : null }
      : null,
    status: null,
  };
}

// ---- pressure and mood -----------------------------------------------------------

test('pressure: the highest quota window wins; without quota, today / budget', () => {
  const r = rules();
  assert.deepEqual(computePressure(snap({ windows: [win('session', 23), win('weekly', 41)] }), r, T0), {
    basis: 'quota', pressure: 41, todayTokens: 0, stale: false,
  });
  assert.equal(computePressure(snap({ tokens: 500_000 }), r, T0).pressure, 25);
  // Quota basis ignores inapplicable and "other" windows
  const odd = computePressure(snap({ windows: [win('session', 10), win('other', 99), win('weekly', 90, { applicable: false })] }), r, T0);
  assert.equal(odd.pressure, 10);
  // moodBasis "budget" ignores the quota
  assert.equal(computePressure(snap({ tokens: 1_000_000, windows: [win('session', 90)] }), rules({ moodBasis: 'budget' }), T0).pressure, 50);
});

test('mood levels: 30 / 60 / 80 / 95; up at once, down only 5 points below the threshold', () => {
  const t = [30, 60, 80, 95];
  assert.equal(stepMood(0, 61, t, 5), 2); // jumps straight to SWEATING
  assert.equal(stepMood(2, 58, t, 5), 2); // 58 is not below 60 - 5
  assert.equal(stepMood(2, 54.9, t, 5), 1);
  assert.equal(stepMood(2, 10, t, 5), 0);
  assert.equal(stepMood(0, 100, t, 5), 4);
});

test('mood: follows the quota and does not flicker around a threshold', () => {
  const brain = new PetBrain(rules(), T0);
  assert.equal(brain.observe(snap({ windows: [win('session', 61)] }), T0).mood, 'SWEATING');
  assert.equal(brain.observe(snap({ windows: [win('session', 59)] }), T0 + MIN).mood, 'SWEATING');
  assert.equal(brain.observe(snap({ windows: [win('session', 61)] }), T0 + 2 * MIN).mood, 'SWEATING');
  assert.equal(brain.observe(snap({ windows: [win('session', 54)] }), T0 + 3 * MIN).mood, 'FOCUSED');
  assert.equal(brain.observe(snap({ windows: [win('session', 96)] }), T0 + 4 * MIN).mood, 'EXHAUSTED');
});

test('mood: frozen while the quota is stale, even if the stale numbers look different', () => {
  const brain = new PetBrain(rules(), T0);
  brain.observe(snap({ windows: [win('session', 85)] }), T0);
  const stale = brain.observe(snap({ windows: [win('session', 10, { stale: true })], error: true }), T0 + MIN);
  assert.equal(stale.mood, 'PANICKED');
  assert.equal(stale.info.stale, true);
  assert.equal(stale.info.basis, 'quota'); // no switch to the budget
  assert.equal(stale.info.pressure, 85); // the last trusted value is shown
});

test('mood change speaks a mood line', () => {
  const brain = new PetBrain(rules(), T0);
  brain.observe(snap({ windows: [win('session', 10)] }), T0);
  const i = brain.observe(snap({ windows: [win('session', 35)] }), T0 + MIN);
  assert.equal(i.bubble?.lineKey, 'mood.FOCUSED');
});

// ---- activity ----------------------------------------------------------------------

test('activity: working while usage is recent, idle after 2 minutes, asleep after 30 minutes', () => {
  const brain = new PetBrain(rules(), T0);
  assert.equal(brain.observe(snap({ tokens: 100, activityAt: T0 }), T0).activity, 'working');
  assert.equal(brain.tick(T0 + 2 * MIN).activity, 'idle');
  assert.equal(brain.tick(T0 + 29 * MIN).activity, 'idle');
  const asleep = brain.tick(T0 + 30 * MIN);
  assert.equal(asleep.activity, 'sleeping');
  assert.equal(asleep.bubble, null);
});

test('activity: new usage wakes her with a stretch; a poke wakes her too', () => {
  const brain = new PetBrain(rules(), T0);
  brain.observe(snap({ tokens: 100, activityAt: T0 }), T0);
  brain.tick(T0 + 40 * MIN);
  const woke = brain.observe(snap({ tokens: 200, activityAt: T0 + 41 * MIN }), T0 + 41 * MIN);
  assert.equal(woke.activity, 'working');
  assert.equal(woke.action?.id, 'wake');
  assert.equal(woke.bubble?.lineKey, 'event.wake');

  brain.tick(T0 + 80 * MIN);
  const poked = brain.interact('poke', T0 + 81 * MIN);
  assert.equal(poked.activity, 'idle');
  assert.equal(poked.action?.id, 'wake');
});

test('activity: asleep, she reacts to nothing but waking up', () => {
  const brain = new PetBrain(rules(), T0);
  brain.observe(snap({ tokens: 100, activityAt: T0, windows: [win('weekly', 40)] }), T0);
  brain.tick(T0 + 40 * MIN);
  // Weekly usage rises from another device while she sleeps: no alert, no speech
  const i = brain.observe(snap({ tokens: 100, activityAt: T0, windows: [win('weekly', 55)] }), T0 + 41 * MIN);
  assert.equal(i.activity, 'sleeping');
  assert.equal(i.action, null);
  assert.equal(i.bubble, null);
});

// ---- events and actions -----------------------------------------------------------

test('eat: usage growth triggers "eat" at most every 2 minutes', () => {
  const brain = new PetBrain(rules(), T0);
  brain.observe(snap({ tokens: 100, activityAt: T0 }), T0);
  assert.equal(brain.observe(snap({ tokens: 200, activityAt: T0 + 10_000 }), T0 + 10_000).action?.id, 'eat');
  brain.tick(T0 + 20_000); // eat finished
  assert.equal(brain.observe(snap({ tokens: 300, activityAt: T0 + 60_000 }), T0 + 60_000).action, null); // cooldown
  assert.equal(brain.observe(snap({ tokens: 400, activityAt: T0 + 3 * MIN }), T0 + 3 * MIN).action?.id, 'eat');
});

test('quota alerts: 50 / 80 / 95 once each per window cycle, never on first sighting', () => {
  const brain = new PetBrain(rules(), T0);
  let t = T0;
  const see = (session: number) => brain.observe(snap({ activityAt: t, windows: [win('session', session)] }), (t += 5 * 1000));

  assert.equal(see(85).action, null); // app started at 85%: no alert
  assert.equal(see(90).action, null); // 80 already counted for this cycle
  const at95 = see(96);
  assert.equal(at95.action?.id, 'alert');
  assert.equal(at95.bubble?.lineKey, 'event.quota.95');
  assert.deepEqual(at95.bubble?.params, { window: 'session', percent: 96 });
  t += 10_000;
  assert.equal(see(97).action, null); // no repeat
});

test('quota alerts: a jump across several thresholds announces only the highest', () => {
  const brain = new PetBrain(rules(), T0);
  brain.observe(snap({ windows: [win('session', 10)] }), T0);
  assert.equal(brain.observe(snap({ windows: [win('session', 82)] }), T0 + MIN).bubble?.lineKey, 'event.quota.80');
});

test('quota reset: celebrate, and alerts become possible again in the new cycle', () => {
  const brain = new PetBrain(rules(), T0);
  brain.observe(snap({ windows: [win('session', 40)] }), T0);
  brain.observe(snap({ windows: [win('session', 55)] }), T0 + MIN); // alert 50
  const reset = brain.observe(snap({ windows: [win('session', 0)] }), T0 + 10 * MIN);
  assert.equal(reset.action?.id, 'celebrate');
  assert.equal(reset.bubble?.lineKey, 'event.quota.reset');
  assert.equal(brain.observe(snap({ windows: [win('session', 52)] }), T0 + 20 * MIN).bubble?.lineKey, 'event.quota.50');
});

test('quota: stale windows trigger neither alerts nor resets', () => {
  const brain = new PetBrain(rules(), T0);
  brain.observe(snap({ windows: [win('session', 40)] }), T0);
  assert.equal(brain.observe(snap({ windows: [win('session', 0, { stale: true })] }), T0 + MIN).action, null);
  assert.equal(brain.observe(snap({ windows: [win('session', 90, { stale: true })] }), T0 + 2 * MIN).action, null);
});

test('new day: greets once when the date changes, unless asleep', () => {
  const brain = new PetBrain(rules(), T0);
  const lateNight = new Date(2026, 9, 27, 23, 59).getTime();
  brain.observe(snap({ activityAt: lateNight }), lateNight);
  const midnight = new Date(2026, 9, 28, 0, 1).getTime();
  const i = brain.observe(snap({ activityAt: lateNight, date: '2026-10-28' }), midnight);
  assert.equal(i.action?.id, 'newDay');
  assert.equal(i.bubble?.lineKey, 'event.newDay');
});

test('poke: 5 pokes within 10 seconds make her annoyed', () => {
  const brain = new PetBrain(rules(), T0);
  const lines: Array<string | undefined> = [];
  for (let i = 0; i < 5; i++) lines.push(brain.interact('poke', T0 + i * 1000).bubble?.lineKey);
  assert.deepEqual(lines, ['user.poke', 'user.poke', 'user.poke', 'user.poke', 'user.pokeAnnoyed']);
  assert.equal(brain.interact('poke', T0 + 30_000).bubble?.lineKey, 'user.poke'); // calmed down
});

test('drag: picked up until released, then lands', () => {
  const brain = new PetBrain(rules(), T0);
  const held = brain.interact('dragStart', T0);
  assert.equal(held.action?.id, 'dragged');
  assert.equal(held.action?.until, null);
  assert.equal(brain.tick(T0 + 60_000).action?.id, 'dragged'); // still held
  const landed = brain.interact('dragEnd', T0 + 61_000);
  assert.equal(landed.action?.id, 'landed');
  assert.equal(brain.tick(T0 + 61_000 + ACTION_MS.landed!).action, null);
});

test('priority: user interaction interrupts; lower actions are dropped; alerts wait their turn', () => {
  const brain = new PetBrain(rules({ eatCooldownMinutes: 0 }), T0);
  brain.observe(snap({ tokens: 100, activityAt: T0, windows: [win('session', 40)] }), T0);

  // eat (2) is interrupted by a poke (5)
  brain.observe(snap({ tokens: 200, activityAt: T0 + 1000, windows: [win('session', 40)] }), T0 + 1000);
  assert.equal(brain.interact('poke', T0 + 1500).action?.id, 'poked');

  // an alert (4) during the poke waits, then plays when the poke ends
  const during = brain.observe(snap({ tokens: 200, activityAt: T0 + 1000, windows: [win('session', 55)] }), T0 + 2000);
  assert.equal(during.action?.id, 'poked');
  const after = brain.tick(T0 + 1500 + ACTION_MS.poked!);
  assert.equal(after.action?.id, 'alert');
  assert.equal(after.bubble?.lineKey, 'event.quota.50');

  // eat (2) during the alert (4, playing from 3.0 s to 6.0 s) is simply dropped, not queued
  const alertEnds = after.action!.until!;
  const dropped = brain.observe(snap({ tokens: 900, activityAt: alertEnds - 1000, windows: [win('session', 55)] }), alertEnds - 1000);
  assert.equal(dropped.action?.id, 'alert');
  assert.equal(brain.tick(alertEnds).action, null);
});

test('bubbles disappear after 6 seconds', () => {
  const brain = new PetBrain(rules(), T0);
  assert.ok(brain.interact('poke', T0).bubble);
  assert.ok(brain.tick(T0 + 5_999).bubble);
  assert.equal(brain.tick(T0 + 6_000).bubble, null);
});

test('chatter: a mood line every 15–30 minutes while awake and quiet; never while asleep', () => {
  const brain = new PetBrain(rules({ chatterMinutes: [15, 30], idleSleepMinutes: 120 }), T0, () => 0.5);
  brain.observe(snap({ windows: [win('session', 35)] }), T0);
  brain.tick(T0 + 10_000); // the mood bubble from the first observation has expired by now
  assert.equal(brain.tick(T0 + 20 * MIN).bubble, null); // 22.5 minutes not reached yet
  const chat = brain.tick(T0 + 23 * MIN);
  assert.equal(chat.bubble?.lineKey, 'mood.FOCUSED');

  const sleepy = new PetBrain(rules({ chatterMinutes: [15, 30], idleSleepMinutes: 10 }), T0, () => 0);
  let last = sleepy.tick(T0);
  for (let m = 1; m <= 60; m++) last = sleepy.tick(T0 + m * MIN);
  assert.equal(last.activity, 'sleeping');
  assert.equal(last.bubble, null);
});

test('new rules from the settings window apply at once', () => {
  const brain = new PetBrain(rules({ dailyBudget: 1000 }), T0);
  assert.equal(brain.observe(snap({ tokens: 900 }), T0).mood, 'PANICKED');
  brain.setRules(rules({ dailyBudget: 10_000 }), T0 + 1000);
  assert.equal(brain.observe(snap({ tokens: 900 }), T0 + 2000).info.pressure, 9);
});

test('rules are pack settings with validated defaults', () => {
  const r = rules();
  assert.deepEqual(r.moodThresholds, [30, 60, 80, 95]);
  assert.deepEqual(r.alertThresholds, [50, 80, 95]);
  assert.equal(r.bubbleSeconds, 6);
  assert.throws(() => rules({ moodThresholds: [30, 20, 80, 95] }));
  assert.throws(() => rules({ chatterMinutes: [30, 15] }));
});
