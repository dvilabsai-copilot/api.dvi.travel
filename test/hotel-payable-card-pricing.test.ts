import assert from 'node:assert/strict';
import test from 'node:test';
import { projectHotelPayablePricing } from '../src/modules/itineraries/utils/hotel-payable-pricing.util';
import {
  decorateHotelCardPricing,
  hotelCardPropertyKey,
} from '../src/modules/itineraries/utils/hotel-card-pricing.util';

test('Axis base 4200 projects once to the same payable 5040 used by preview and persistence', () => {
  const projected = projectHotelPayablePricing({
    provider: 'axisrooms',
    canonicalHotelId: 232,
    hotelCode: '232',
    pricePerNight: 4200,
    totalPrice: 4200,
  }, 20);

  assert.equal(projected.basePricePerNight, 4200);
  assert.equal(projected.hotelMarginAmount, 840);
  assert.equal(projected.pricePerNight, 5040);
  assert.equal(projected.totalPrice, 5040);
  assert.equal(projected.amountIncludesHotelMargin, true);
  assert.equal(projectHotelPayablePricing(projected, 20).totalPrice, 5040);
});

test('nested supplier options retain the idempotency marker after projection', () => {
  const projected = projectHotelPayablePricing({
    provider: 'hobse',
    hotelCode: 'ABC',
    baseTotalPrice: 4020,
    totalPrice: 4020,
    rateOptions: [{
      rateOptionId: 'hobse-rate-1',
      baseTotalPrice: 4020,
      totalPrice: 4020,
    }],
  }, 10);

  const nested = projected.rateOptions[0];
  assert.equal(nested.totalPrice, 4422);
  assert.equal(nested.baseTotalPrice, 4020);
  assert.equal(nested.amountIncludesHotelMargin, true);
  assert.equal(projectHotelPayablePricing(projected, 10).rateOptions[0].totalPrice, 4422);
});

test('ResAvenue margin projection remains idempotent at 9499 -> 10448.90', () => {
  const projected = projectHotelPayablePricing({
    provider: 'resavenue', hotelCode: '20', baseTotalPrice: 9499, totalPrice: 9499,
    rateOptions: [{ rateOptionId: 'RESAVENUE-20-rate', baseTotalPrice: 9499, totalPrice: 9499 }],
  }, 10);
  assert.equal(projected.rateOptions[0].baseTotalPrice, 9499);
  assert.equal(projected.rateOptions[0].totalPrice, 10448.9);
  assert.equal(projectHotelPayablePricing(projected, 10).rateOptions[0].totalPrice, 10448.9);
});

test('card identity is stable across supplier hotel-code representations', () => {
  const base = {
    itineraryRouteId: 10145,
    groupType: 1,
    provider: 'axisrooms',
    canonicalHotelId: 232,
    hotelName: 'THE ARBOUR RESORT',
  };
  assert.equal(
    hotelCardPropertyKey({ ...base, hotelCode: '232' }),
    hotelCardPropertyKey({ ...base, hotelCode: '435' }),
  );
});

test('card starting amount and difference use payable nested options', () => {
  const rows = decorateHotelCardPricing([{
    itineraryRouteId: 10145,
    groupType: 1,
    provider: 'axisrooms',
    canonicalHotelId: 232,
    hotelCode: '232',
    hotelName: 'THE ARBOUR RESORT',
    rateOptions: [
      { rateOptionId: 'CP', pricePerNight: 5040 },
      { rateOptionId: 'MAP', pricePerNight: 7920 },
      { rateOptionId: 'AP', pricePerNight: 10800 },
    ],
  }], new Map([['10145-1', 5040]]));

  assert.equal(rows[0].startingFromAmount, 5040);
  assert.deepEqual(rows[0].rateOptions.map((option: any) => option.priceDifference), [0, 2880, 5760]);
});

