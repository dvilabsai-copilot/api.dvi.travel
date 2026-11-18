import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldOmitSyntheticDepartureStart } from '../src/modules/itineraries/utils/departure-timeline-display.util';

test('transfer-only final day has no invented breakfast regardless of terminal name', () => {
  assert.equal(shouldOmitSyntheticDepartureStart({ routeIndex: 2, routeCount: 3,
    rows: [{ item_type: 7 }] }), true);
});

test('real refreshment, sightseeing, empty and non-final days retain existing start display', () => {
  for (const rows of [[], [{ item_type: 1 }, { item_type: 7 }],
    [{ item_type: 4 }, { item_type: 7 }]]) {
    assert.equal(shouldOmitSyntheticDepartureStart({ routeIndex: 2, routeCount: 3, rows }), false);
  }
  assert.equal(shouldOmitSyntheticDepartureStart({ routeIndex: 0, routeCount: 3,
    rows: [{ item_type: 7 }] }), false);
});

test('single-day transfer-only itinerary also avoids a synthetic breakfast', () => {
  assert.equal(shouldOmitSyntheticDepartureStart({ routeIndex: 0, routeCount: 1,
    rows: [{ item_type: '7' }] }), true);
});
