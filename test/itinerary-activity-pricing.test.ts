import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryActivityPricingService } from '../src/modules/itineraries/services/itinerary-activity-pricing.service';

function createDb(priceRows: any[], datedPriceRows = priceRows) {
  let pricebookReads = 0;
  return {
    dvi_itinerary_plan_details: { findFirst: async () => ({ total_adult: 2, total_children: 1, nationality: 1, trip_start_date_and_time: '2026-07-16T00:00:00.000Z' }) },
    dvi_itinerary_route_details: { findFirst: async () => ({ itinerary_route_date: '2026-07-17T00:00:00.000Z' }) },
    dvi_countries: { findFirst: async () => ({ shortname: 'IN' }) },
    dvi_activity_pricebook: { findMany: async () => pricebookReads++ === 0 ? datedPriceRows : priceRows },
  };
}

test('calculates adult and child pricing from the route date', async () => {
  const service = new ItineraryActivityPricingService({} as any);
  const result = await service.calculateActivityPlanPricing({ planId: 1, routeId: 2, activityId: 3 }, createDb([
    { price_type: 1, day_17: 100 }, { price_type: 2, day_17: 40 },
  ]));
  assert.deepEqual(result, {
    pricingUnitType: 'PER_ADULT', priceUnitLabel: 'per adult', nationalityType: 1,
    adults: 2, children: 1, adultRate: 100, childRate: 40, unitRate: 0,
    totalAmount: 240, priceDate: '2026-07-17',
  });
});

test('uses unit pricing and day-one fallback when the dated book is empty', async () => {
  const service = new ItineraryActivityPricingService({} as any);
  const result = await service.calculateActivityPlanPricing({ planId: 1, routeId: 2, activityId: 3 }, createDb([
    { price_type: 4, day_1: 275 },
  ], []));
  assert.equal(result.pricingUnitType, 'UNIT');
  assert.equal(result.totalAmount, 275);
  assert.equal(result.priceUnitLabel, 'per unit');
});
