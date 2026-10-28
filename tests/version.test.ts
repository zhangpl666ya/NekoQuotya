import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions } from '../src/shared/version.ts';

test('versions compare numerically, not as text', () => {
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
});

test('a pre-release suffix is ignored', () => {
  assert.equal(compareVersions('1.0.1-dev', '1.0.1'), 0);
});
