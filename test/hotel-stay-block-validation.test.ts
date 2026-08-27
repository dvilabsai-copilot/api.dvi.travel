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

test('AxisRooms business dates use the database IST-midnight boundary', () => {
  const service = serviceWithRoutes([]);
  const databaseDate = (service as any).toDatabaseBusinessDate('2026-09-07') as Date;
  assert.equal(databaseDate.toISOString(), '2026-09-07T00:00:00.000Z');
});

test('AxisRooms resolves short meal codes to the matching rate plan', async () => {
  const service = new HotelStayBlockValidationService({
    dvi_hotel_room_rate_plan: {
      findMany: async () => [
        { rateplan_id: 'AP_PLAN', rateplan_name: 'American Plan', rate_plan_code: null },
        { rateplan_id: 'CP_PLAN', rateplan_name: 'Continental Plan', rate_plan_code: null },
        { rateplan_id: 'MAP_PLAN', rateplan_name: 'Modified American Plan', rate_plan_code: null },
      ],
    },
  } as any);

  for (const [mealPlan, expected] of [['AP', 'AP_PLAN'], ['CP', 'CP_PLAN'], ['MAP', 'MAP_PLAN']] as const) {
    const resolved = await (service as any).resolveAxisRatePlan(95, 231, undefined, mealPlan);
    assert.equal(resolved.ratePlanId, expected);
  }
});

test('fresh TBO validation selects positive price fields from duplicate response rows', async () => {
  const service = new HotelStayBlockValidationService({
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'Q-1' }),
    },
  } as any, {
    getSelectedHotelRates: async () => ({
      hotels: [
          {
            itineraryRouteId: 101,
            provider: 'tbo',
            hotelCode: 'H-1',
            roomType: 'Deluxe Room',
            mealPlan: 'CP',
            rateOptions: [{
              provider: 'tbo',
              hotelCode: 'H-1',
              roomType: 'Deluxe Room',
              mealPlan: 'CP',
              price: 100,
              netAmount: 100,
              totalFare: 100,
            }],
          },
        {
          itineraryRouteId: 101,
            provider: 'tbo', hotelCode: 'H-1', roomType: 'Deluxe Room', mealPlan: 'CP',
            pricePerNight: 0,
        },
        {
          itineraryRouteId: 102,
            provider: 'tbo', hotelCode: 'H-1', roomType: 'Deluxe Room', mealPlan: 'CP',
            pricePerNight: 110,
        },
      ],
    }),
  } as any);

  const result = await (service as any).validateSnapshotStayBlock({
    ...baseParams,
    hotelName: 'Test Hotel',
    checkInDate: '2026-08-12',
    checkOutDate: '2026-08-14',
    nights: 2,
    routeIds: [101, 102],
    stayDates: ['2026-08-12', '2026-08-13'],
    stayKey: 'tbo:H-1:2026-08-12_to_2026-08-14',
  });

  assert.equal(result.canBookMultiNight, true);
  assert.deepEqual(result.nightlyRates.map((rate: any) => rate.amountAfterTax), [100, 110]);
});
