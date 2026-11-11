import assert from 'node:assert/strict';
import test from 'node:test';
import { getHotspotClosingGraceMinutes } from '../src/modules/itineraries/utils/hotspot-closing-grace.util';

test('allows a 30-minute closing grace for visits longer than four hours', () => {
  assert.equal(getHotspotClosingGraceMinutes(10 * 60 + 3, 18 * 60 + 3), 30);
});

test('does not add closing grace to visits of four hours or less', () => {
  assert.equal(getHotspotClosingGraceMinutes(14 * 60, 18 * 60), 0);
});

test('calculates long visit grace across midnight', () => {
  assert.equal(getHotspotClosingGraceMinutes(21 * 60, 2 * 60), 30);
});
