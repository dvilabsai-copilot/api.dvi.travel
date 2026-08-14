import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHotelSelectionPricing } from '../src/modules/itineraries/utils/hotel-selection-pricing.util';

test('persists an explicit occupancy total without multiplying it again', () => {
  assert.deepEqual(
    resolveHotelSelectionPricing({ totalPrice: 9680, pricePerNight: 4840, roomCount: 2 }),
    { roomCount: 2, totalPrice: 9680, roomRate: 4840 },
  );
});

test('multiplies a per-room fallback rate by the requested room count', () => {
  assert.deepEqual(
    resolveHotelSelectionPricing({ pricePerNight: 4840, roomCount: 2 }),
    { roomCount: 2, totalPrice: 9680, roomRate: 4840 },
  );
});
