import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TBO_CHILD_AGE,
  distributeTboSearchOccupancies,
  resolveSavedTboChildAges,
} from '../src/modules/hotels/utils/tbo-occupancy.util';

test('saved TBO child ages preserve entered ages and default only missing or invalid values to age 5', () => {
  assert.deepEqual(resolveSavedTboChildAges([
    { traveller_age: '8' },
    { traveller_age: null },
    { traveller_age: '12' },
  ], 3), [8, DEFAULT_TBO_CHILD_AGE, DEFAULT_TBO_CHILD_AGE]);
});

test('TBO search occupancy distribution preserves child age order across rooms', () => {
  assert.deepEqual(distributeTboSearchOccupancies(2, 4, 3, [6, 8, 10]), [
    { adults: 2, children: 2, childrenAges: [6, 8] },
    { adults: 2, children: 1, childrenAges: [10] },
  ]);
});
