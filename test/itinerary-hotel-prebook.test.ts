import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelPrebookService } from '../src/modules/itineraries/services/itinerary-hotel-prebook.service';

function createService(bookable: any[] = []) {
  const service = new ItineraryHotelPrebookService(null as any, null as any, null as any, null as any);
  service.setCallbacks({
    normalizeToArray: (value: any) => (Array.isArray(value) ? value : value == null ? [] : [value]),
    normalizeToUniqueStrings: (values: any[]) => Array.from(new Set(values.map(String).filter(Boolean))),
    inferMealPlanFromInclusions: () => null,
    getProviderBookableHotelBookings: () => bookable,
  });
  return service;
}

test('hotel prebook preserves the empty-selection response', async () => {
  const result = await createService().prebookHotels({ itinerary_plan_ID: 99, hotel_bookings: [] } as any);

  assert.equal(result.success, true);
  assert.equal(result.message, 'No supplier-bookable hotels selected for prebook');
  assert.equal(result.totalAmount, 0);
});

test('hotel prebook preserves skipped external-stay counting', async () => {
  const result = await createService([]).prebookHotels({
    itinerary_plan_ID: 99,
    hotel_bookings: [{ provider: 'external', routeId: 1 }],
  } as any);

  assert.equal(result.skippedExternalStayCount, 1);
  assert.deepEqual(result.hotels, []);
});
