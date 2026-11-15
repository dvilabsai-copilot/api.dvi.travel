import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelDetailsTboService } from '../src/modules/itineraries/itinerary-hotel-details-tbo.service';

const savedTravellers = [
  ...[1, 1, 2, 2, 3, 3, 4, 4].map((room_id) => ({ room_id, traveller_type: 1, traveller_age: null })),
  { room_id: 1, traveller_type: 2, traveller_age: '9' },
  { room_id: 1, traveller_type: 2, traveller_age: '8' },
];

const stay = {
  planId: 10,
  routeIds: [20, 21],
  provider: 'tbo',
  hotelCode: '1169407',
  checkInDate: '2026-12-07',
  checkOutDate: '2026-12-09',
};

function setup(travellers: ReadonlyArray<(typeof savedTravellers)[number]>) {
  const service = Object.create(ItineraryHotelDetailsTboService.prototype);
  const searches: Record<string, unknown>[] = [];
  const travellerLookups: number[] = [];
  service.prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_plan_ID: 10, preferred_room_count: 4, total_adult: 8, total_children: 2 }),
    },
    dvi_itinerary_route_details: { findFirst: async () => ({ next_visiting_location: 'Mahabalipuram' }) },
    dvi_itinerary_traveller_details: {
      findMany: async ({ where }: { where: { itinerary_plan_ID: number } }) => {
        travellerLookups.push(where.itinerary_plan_ID);
        return travellers;
      },
    },
  };
  service.logger = { log: () => undefined };
  service.getTboMapFallbackConfig = async () => ({});
  service.hotelSearchService = {
    searchHotels: async (criteria: Record<string, unknown>) => {
      searches.push(criteria);
      return [];
    },
  };
  return { service: service as ItineraryHotelDetailsTboService, searches, travellerLookups };
}

test('switching hotels and back sends the saved rooming and child ages to TBO every time', async () => {
  const { service, searches, travellerLookups } = setup(savedTravellers);

  await service.searchSelectedHotelForContinuousStay(stay);
  await service.searchSelectedHotelForContinuousStay({ ...stay, hotelCode: '1083977' });
  await service.searchSelectedHotelForContinuousStay({ ...stay, provider: 'vsr' });
  await service.searchSelectedHotelForContinuousStay({ ...stay, routeIds: [20], checkOutDate: '2026-12-08' });

  assert.deepEqual(travellerLookups, [10, 10, 10, 10]);
  assert.deepEqual(searches.map(({ hotelCodes }) => hotelCodes), ['1169407', '1083977', '1169407', '1169407']);
  assert.deepEqual(searches[2], searches[0]);
  for (const criteria of searches) {
    assert.deepEqual(criteria.providers, ['tbo']);
    assert.deepEqual(criteria.childAges, [9, 8]);
    assert.deepEqual(criteria.occupancies, [
      { adults: 2, children: 2, childrenAges: [9, 8] },
      { adults: 2, children: 0, childrenAges: [] },
      { adults: 2, children: 0, childrenAges: [] },
      { adults: 2, children: 0, childrenAges: [] },
    ]);
  }
});

test('TBO keeps known child ages and leaves fallback occupancy to the search service for incomplete rooming', async () => {
  for (const [travellers, childAges] of [[savedTravellers.slice(1), [9, 8]], [[], []]] as const) {
    const { service, searches } = setup(travellers);
    await service.searchSelectedHotelForContinuousStay(stay);
    assert.deepEqual(searches[0]?.childAges, childAges);
    assert.equal(searches[0]?.occupancies, undefined);
  }
});

test('ResAvenue continuous search retains its existing guest criteria', async () => {
  const { service, searches, travellerLookups } = setup(savedTravellers);

  await service.searchSelectedHotelForContinuousStay({ ...stay, provider: 'resavenue' });

  assert.deepEqual(travellerLookups, []);
  assert.deepEqual(searches[0], {
    cityCode: 'Mahabalipuram', checkInDate: stay.checkInDate, checkOutDate: stay.checkOutDate,
    roomCount: 4, guestCount: 10, adultCount: 8, childCount: 2, guestNationality: 'IN',
    providers: ['resavenue'], hotelCodes: stay.hotelCode,
  });
});
