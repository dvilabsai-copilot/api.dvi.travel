import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDateOnly,
  inferMealPlanFromInclusions,
  normalizeManualHotspotIds,
  normalizeToArray,
  normalizeToUniqueStrings,
  parseCsvNumberList,
  parseRouteFamilyQuote,
  toDateOnly,
} from '../src/modules/itineraries/services/itinerary-input-normalization.service';

test('normalizes CSV, dates and route-family quote suffixes', () => {
  assert.deepEqual(parseCsvNumberList('1, 2, invalid, 0'), [1, 2]);
  assert.equal(formatDateOnly('2026-07-17T10:30:00Z'), '2026-07-17');
  assert.equal(toDateOnly('invalid'), '');
  assert.deepEqual(parseRouteFamilyQuote('DVI-42-R3'), { baseQuoteId: 'DVI-42', routeVariantIndex: 3 });
  assert.deepEqual(parseRouteFamilyQuote('DVI-42'), { baseQuoteId: 'DVI-42', routeVariantIndex: null });
});

test('normalizes mixed arrays and removes duplicate display strings case-insensitively', () => {
  assert.deepEqual(normalizeToArray(' breakfast '), ['breakfast']);
  assert.deepEqual(normalizeToArray({ name: 'WiFi' }), [{ name: 'WiFi' }]);
  assert.deepEqual(normalizeToUniqueStrings(['Breakfast', 'breakfast', { name: 'WiFi' }, { label: 'Pool' }]), [
    'Breakfast',
    'WiFi',
    'Pool',
  ]);
});

test('keeps meal-plan and manual-hotspot normalization precedence stable', () => {
  assert.equal(inferMealPlanFromInclusions(['Breakfast', 'Dinner']), 'Breakfast Included');
  assert.equal(inferMealPlanFromInclusions(['Half Board', 'Breakfast']), 'Half Board');
  assert.equal(inferMealPlanFromInclusions([]), null);
  assert.deepEqual(normalizeManualHotspotIds([3, '3', 0, 'invalid', 5]), [3, 5]);
});
