import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampToArea } from '../src/main/geometry.ts';

const area = { x: 0, y: 0, width: 1400, height: 850 };
const win = { width: 240, height: 316 };
// Placeholder pet: 96 px bubble space + 28 px canvas margin on top, 42 px of empty sides
const overhang = { top: 124, left: 42, right: 42, bottom: 20 };

test('a pet can be dragged up until the character, not the window, touches the top edge', () => {
  assert.deepEqual(clampToArea({ x: 500, y: -500, ...win }, area, overhang), { x: 500, y: -124, ...win });
  // Without overhang the window itself stops at the edge (the old behavior)
  assert.equal(clampToArea({ x: 500, y: -500, ...win }, area, { top: 0, left: 0, right: 0, bottom: 0 }).y, 0);
});

test('the sides and bottom allow only their transparent margins past the edge', () => {
  assert.equal(clampToArea({ x: -999, y: 100, ...win }, area, overhang).x, -42);
  assert.equal(clampToArea({ x: 9999, y: 100, ...win }, area, overhang).x, 1400 - 240 + 42);
  assert.equal(clampToArea({ x: 100, y: 9999, ...win }, area, overhang).y, 850 - 316 + 20);
});

test('positions inside the area are kept (rounded)', () => {
  assert.deepEqual(clampToArea({ x: 300.4, y: 200.6, ...win }, area, overhang), { x: 300, y: 201, ...win });
});
