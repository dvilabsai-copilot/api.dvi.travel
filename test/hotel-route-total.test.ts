import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isFullStayHotelSelection,
  shouldSkipRepeatedHotelNight,
} from '../src/modules/itineraries/utils/hotel-route-total.util';

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

test('keeps route-specific totals separate when each row is priced per night', () => {
  assert.equal(isFullStayHotelSelection({
    pricePerNight: 47160,
    totalPrice: 47160,
  }), false);
});

test('recognizes a saved stay total as one full-stay amount', () => {
  assert.equal(isFullStayHotelSelection({
    pricePerNight: 47160,
    totalPrice: 141480,
  }), true);
});
