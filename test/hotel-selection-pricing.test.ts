import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHotelOccupancyPricing } from '../src/modules/itineraries/utils/hotel-selection-pricing.util';

test('uses DOUBLE plus supplements for three adults', () => {
  const result = resolveHotelOccupancyPricing({
    rates: { SINGLE: 5000, DOUBLE: 5000, EXTRABED: 4600, CHILD_WITHOUT_BED: 1800 },
    roomCount: 1,
    adultCount: 3,
    extraBedCount: 1,
    childWithoutBedCount: 1,
    marginPercentage: 10,
  });

  assert.equal(result.roomOccupancy, 'DOUBLE');
  assert.equal(result.baseTotalPrice, 5000);
  assert.equal(result.extraBedAmount, 4600);
  assert.equal(result.childWithoutBedAmount, 1800);
  assert.equal(result.hotelMarginBaseAmount, 11400);
  assert.equal(result.hotelMarginAmount, 1140);
  assert.equal(result.totalPrice, 12540);
});
