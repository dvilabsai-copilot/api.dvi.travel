import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveHotelOccupancyPricing,
  resolveHotelSupplementPricing,
  resolveOfflineHotelPayablePricing,
} from '../src/modules/itineraries/utils/hotel-selection-pricing.util';
import { projectHotelPayablePricing } from '../src/modules/itineraries/utils/hotel-payable-pricing.util';

test('normalizes an amount-only supplement into a matching unit rate', () => {
  const result = resolveHotelSupplementPricing({
    count: 1,
    rate: 0,
    amount: 2125,
  });

  assert.deepEqual(result, { count: 1, rate: 2125, amount: 2125 });
});

test('preserves the authoritative supplement amount for multiple occupants', () => {
  const result = resolveHotelSupplementPricing({
    count: 2,
    rate: 900,
    amount: 2125,
  });

  assert.deepEqual(result, { count: 2, rate: 1062.5, amount: 2125 });
});

test('uses the legacy cost field when the normalized amount is zero', () => {
  const result = resolveHotelSupplementPricing({
    count: 1,
    rate: 0,
    amount: 0,
    cost: 1500,
  });

  assert.deepEqual(result, { count: 1, rate: 1500, amount: 1500 });
});

test('projects an automatic option with a positive supplement rate and zero amount consistently', () => {
  const result = projectHotelPayablePricing({
    provider: 'axisrooms',
    roomCount: 2,
    baseTotalPrice: 20200,
    totalRoomCost: 20200,
    extraBedCount: 1,
    extraBedRate: 1600,
    extraBedAmount: 1600,
    childWithoutBedCount: 1,
    childWithoutBedRate: 2250,
    childWithoutBedAmount: 0,
    hotelMarginPercentage: 6,
  }, 6);

  assert.equal(result.childWithoutBedRate, 2250);
  assert.equal(result.childWithoutBedAmount, 2250);
  assert.equal(result.totalChildWithoutBedCost, 2250);
  assert.equal(result.totalPrice, 25493);
});

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
