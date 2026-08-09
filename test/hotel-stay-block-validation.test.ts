import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelStayBlockValidationService } from '../src/modules/itineraries/services/hotel-stay-block-validation.service';

function serviceWithRoutes(routes: any[]) {
  return new HotelStayBlockValidationService({
    dvi_itinerary_route_details: {
      findMany: async () => routes,
    },
  } as any);
}

const baseParams = {
  planId: 44,
  provider: 'tbo' as const,
  hotelCode: 'H-1',
  roomType: 'Deluxe Room',
  mealPlan: 'CP',
};

function routes() {
  return [
    { itinerary_route_ID: 101, itinerary_route_date: new Date('2026-08-12T00:00:00.000Z'), location_name: 'Cochin', next_visiting_location: 'Munnar' },
    { itinerary_route_ID: 102, itinerary_route_date: new Date('2026-08-13T00:00:00.000Z'), location_name: 'Munnar', next_visiting_location: 'Munnar' },
    { itinerary_route_ID: 103, itinerary_route_date: new Date('2026-08-14T00:00:00.000Z'), location_name: 'Munnar', next_visiting_location: 'Munnar' },
  ];
}

test('continuous stay discovery is bidirectional and provider-independent', async () => {
  const service = serviceWithRoutes(routes());
  for (const [routeId, checkInDate] of [[101, '2026-08-12'], [102, '2026-08-13'], [103, '2026-08-14']] as const) {
    const candidate = await service.buildContinuousStayCandidate({
      ...baseParams,
      routeId,
      checkInDate,
    });
    assert.deepEqual(candidate.routeIds, [101, 102, 103]);
    assert.deepEqual(candidate.stayDates, ['2026-08-12', '2026-08-13', '2026-08-14']);
    assert.equal(candidate.nights, 3);
  }
});

test('continuous stay stops at a destination boundary', async () => {
  const service = serviceWithRoutes([
    ...routes().slice(0, 2),
    { itinerary_route_ID: 103, itinerary_route_date: new Date('2026-08-14T00:00:00.000Z'), location_name: 'Munnar', next_visiting_location: 'Thekkady' },
  ]);
  const candidate = await service.buildContinuousStayCandidate({
    ...baseParams,
    routeId: 102,
    checkInDate: '2026-08-13',
  });
  assert.deepEqual(candidate.routeIds, [101, 102]);
});
