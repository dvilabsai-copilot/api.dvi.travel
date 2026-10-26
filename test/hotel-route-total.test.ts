import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSkipRepeatedHotelNight } from '../src/modules/itineraries/utils/hotel-route-total.util';

const previousDate = Date.parse('2026-12-31T00:00:00Z');
const nextDate = Date.parse('2027-01-01T00:00:00Z');

test('keeps every night for a route-night snapshot', () => {
  assert.equal(shouldSkipRepeatedHotelNight({
    numberOfNights: 3,
    selectedPriceSnapshot: JSON.stringify({ pricingScope: 'ROUTE_NIGHT' }),
  }, previousDate, nextDate), false);
});

test('skips a repeated night for an explicit continuous-stay amount', () => {
  assert.equal(shouldSkipRepeatedHotelNight({ numberOfNights: 3 }, previousDate, nextDate), true);
});
