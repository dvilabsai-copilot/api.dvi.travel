import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHotelOccupancyPricing,
  resolveOfflineHotelPayablePricing,
} from '../src/modules/itineraries/utils/hotel-selection-pricing.util';

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

test('adds offline MAP to the subtotal without applying hotel margin to food', () => {
  const result = resolveOfflineHotelPayablePricing({
    baseTotalPrice: 8100,
    extraBedAmount: 750,
    childWithoutBedAmount: 300,
    mealPlanCost: 3900.6,
    marginPercentage: 5,
  });

  assert.equal(result.marginableBaseAmount, 9150);
  assert.equal(result.subtotal, 13050.6);
  assert.equal(result.marginAmount, 457.5);
  assert.equal(result.totalPrice, 13508.1);
});
