import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImageAppearanceSchema, pickVisual, visualKeys } from '../src/shared/appearance.ts';
import { DEFAULT_LINES, mergeLines, parseLinesFile, resolveLine } from '../src/shared/lines.ts';

test('lines: pack language → pack English → core language → core English', () => {
  const merged = mergeLines('zh-CN', { 'user.poke': ['戳我干嘛'] }, { 'user.poke': ['Hey you'], 'event.eat': ['Yum'] });
  assert.deepEqual(merged['user.poke'], ['戳我干嘛']); // pack, in the user's language
  assert.deepEqual(merged['event.eat'], ['Yum']); // pack English beats core Chinese
  assert.deepEqual(merged['event.wake'], DEFAULT_LINES['zh-CN']['event.wake']); // core, in the user's language
  assert.deepEqual(mergeLines('en', { 'user.poke': ['ignored'] }, null)['user.poke'], DEFAULT_LINES.en['user.poke']);
});

test('lines: the bubble id picks the variant; parameters are filled in', () => {
  const lines = { 'user.poke': ['a', 'b', 'c'], 'event.quota.any': ['Quota passed {percent}%!'] };
  assert.equal(resolveLine(lines, 'user.poke', 4), 'b');
  assert.equal(resolveLine(lines, 'user.poke', 4), 'b'); // stable for the same bubble
  assert.equal(resolveLine(lines, 'event.quota.80', 1, { percent: 81 }), 'Quota passed 81%!'); // generic quota fallback
  assert.equal(resolveLine(lines, 'event.newDay', 1), ''); // unknown → no bubble
});

test('lines files are parsed leniently', () => {
  assert.deepEqual(parseLinesFile({ a: 'one', b: ['x', 2, ''], c: 5, d: [] }), { a: ['one'], b: ['x'] });
  assert.deepEqual(parseLinesFile(null), {});
});

test('image appearance: mood.ENERGETIC is required; visuals fall back from action to mood to ENERGETIC', () => {
  assert.throws(() => ImageAppearanceSchema.parse({ size: [200, 200], images: { 'mood.SWEATING': 'a.png' } }));
  const intent = { mood: 'SWEATING', activity: 'sleeping', action: { id: 'poked', startedAt: 0, until: 1 } } as const;
  assert.deepEqual(visualKeys(intent), ['action.poked', 'activity.sleeping', 'mood.SWEATING', 'mood.ENERGETIC']);
  assert.equal(pickVisual(['mood.ENERGETIC', 'mood.SWEATING'], intent), 'mood.SWEATING');
  assert.equal(pickVisual(['mood.ENERGETIC', 'activity.sleeping'], intent), 'activity.sleeping');
  assert.equal(pickVisual(['mood.ENERGETIC'], { mood: 'PANICKED', activity: 'idle', action: null }), 'mood.ENERGETIC');
});
