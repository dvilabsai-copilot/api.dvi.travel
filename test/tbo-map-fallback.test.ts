import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMapDinnerFallbackToRows,
  filterEpRows,
} from '../src/modules/itineraries/utils/tbo-map-fallback.util';

const config = {
  enabled: true,
  dinnerRate3Star: 900,
  dinnerRate4Star: 1500,
  dinnerRate5Star: 2500,
};

test('adds a synthetic MAP option from TBO CP with the configured dinner supplement', () => {
  const rows = applyMapDinnerFallbackToRows([
    {
      provider: 'tbo',
      hotelCode: 'TBO-3STAR',
      providerHotelCode: 'TBO-3STAR',
      hotelName: 'Three Star Hotel',
      rating: 3,
      mealPlan: 'CP',
      price: 10000,
      totalFare: 10000,
      bookingCode: 'TBO-CP-BOOKING',
      searchReference: 'TBO-CP-BOOKING',
      roomType: 'Deluxe Room',
    },
  ], { preferredMealPlanCode: 'MAP', adultCount: 2, childCount: 0, roomCount: 1, numberOfNights: 1 }, config);

  assert.equal(rows.length, 2);
  const fallback = rows.find((row) => row.tboMapFallbackApplied === true);
  assert.ok(fallback);
  assert.equal(fallback.mealPlan, 'MAP');
  assert.equal(fallback.supplierMealPlan, 'CP');
  assert.equal(fallback.tboMapFallbackDinnerTotal, 1800);
  assert.equal(fallback.totalPrice, 11800);
  assert.equal(fallback.bookingCode, 'TBO-CP-BOOKING');
  assert.match(String(fallback.rateOptionId), /MAP_FALLBACK$/);
});

test('keeps a real MAP unchanged when CP and MAP both exist for the property', () => {
  const rows = applyMapDinnerFallbackToRows([
    { provider: 'tbo', hotelCode: 'TBO-4STAR', hotelName: 'Hotel', rating: 4, mealPlan: 'CP', price: 10000, bookingCode: 'CP-BOOKING' },
    { provider: 'tbo', hotelCode: 'TBO-4STAR', hotelName: 'Hotel', rating: 4, mealPlan: 'MAP', price: 12000, bookingCode: 'MAP-BOOKING' },
  ], { preferredMealPlanCode: 'MAP', adultCount: 2, childCount: 0, roomCount: 1 }, config);

  assert.equal(rows.length, 2);
  assert.equal(rows.some((row) => row.tboMapFallbackApplied === true), false);
  assert.equal(rows.find((row) => row.bookingCode === 'MAP-BOOKING')?.price, 12000);
});

test('keeps a MAP-only TBO rate unchanged without a dinner supplement', () => {
  const rows = applyMapDinnerFallbackToRows([
    { provider: 'tbo', hotelCode: 'TBO-MAP-ONLY', hotelName: 'MAP Hotel', rating: 4, mealPlan: 'MAP', price: 12000 },
  ], { preferredMealPlanCode: 'MAP', adultCount: 2, childCount: 0, roomCount: 1 }, config);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].mealPlan, 'MAP');
  assert.equal(rows[0].price, 12000);
  assert.equal(rows[0].tboMapFallbackApplied, undefined);
});

test('applies the same CP-only fallback to Offline providers', () => {
  const rows = applyMapDinnerFallbackToRows([
    { provider: 'offline', hotelCode: 'OFFLINE', hotelName: 'Offline', rating: 3, mealPlan: 'CP', price: 10000 },
  ], { preferredMealPlanCode: 'MAP', adultCount: 2, childCount: 0, roomCount: 1 }, config);

  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.tboMapFallbackApplied === true)?.tboMapFallbackDinnerTotal, 1800);
});

test('does not change non-MAP requests', () => {
  const rows = [
    { provider: 'tbo', hotelCode: 'CP-ONLY', hotelName: 'TBO', rating: 5, mealPlan: 'CP', price: 10000 },
    { provider: 'offline', hotelCode: 'OFFLINE', hotelName: 'Offline', rating: 5, mealPlan: 'CP', price: 10000 },
  ];

  assert.deepEqual(
    applyMapDinnerFallbackToRows(rows, { preferredMealPlanCode: 'CP', adultCount: 2, childCount: 0, roomCount: 1 }, config),
    rows,
  );
});

test('hides EP rows and nested EP options by default', () => {
  const rows = filterEpRows([
    { provider: 'offline', hotelCode: 'EP-ONLY', mealPlan: 'EP' },
    {
      provider: 'offline',
      hotelCode: 'MIXED',
      rateOptions: [
        { mealPlan: 'EP', price: 1000 },
        { mealPlan: 'CP', price: 1200 },
      ],
    },
  ] as any[], false);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].rateOptions, [{ mealPlan: 'CP', price: 1200 }]);
});
