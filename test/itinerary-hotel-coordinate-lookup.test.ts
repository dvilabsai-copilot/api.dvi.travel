import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryHotelCoordinateLookupService } from '../src/modules/itineraries/services/itinerary-hotel-coordinate-lookup.service';

test('loads route and provider coordinates and fills a missing TBO coordinate from static master', async () => {
  const result = await new ItineraryHotelCoordinateLookupService().load({
    routes: [{ location_id: 5 }, { location_id: 5 }, { location_id: 0 }],
    packages: [{ hotels: [{ provider: 'tbo', hotelCode: 'T1' }, { provider: 'staah', hotelCode: '10' }] }],
    loadStoredLocations: async (ids) => {
      assert.deepEqual(ids, [5]);
      return [{ location_ID: 5, destination_location_lattitude: 12, destination_location_longitude: 77 }];
    },
    loadHotelMasters: async () => [
      { hotel_id: 10, tbo_hotel_code: 'T1', hotel_latitude: 0, hotel_longitude: 0 },
    ],
    loadTboMasters: async (codes) => {
      assert.deepEqual(codes, ['T1']);
      return [{ tbo_hotel_code: 'T1', hotel_latitude: 13, hotel_longitude: 78 }];
    },
  });

  assert.deepEqual(result.routeDestinationCoordsByLocationId.get(5), { lat: 12, lon: 77 });
  assert.deepEqual(result.hotelCoordsByProviderCode.get('tbo|T1'), { lat: 13, lon: 78 });
  assert.deepEqual(result.hotelCoordsByProviderCode.get('staah|10'), undefined);
});

test('does not issue coordinate queries when routes and packages have no usable IDs', async () => {
  let calls = 0;
  const result = await new ItineraryHotelCoordinateLookupService().load({
    routes: [{ location_id: 0 }],
    packages: [{ hotels: [{ provider: 'tbo', hotelCode: '' }] }],
    loadStoredLocations: async () => {
      calls += 1;
      return [];
    },
    loadHotelMasters: async () => {
      calls += 1;
      return [];
    },
    loadTboMasters: async () => {
      calls += 1;
      return [];
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.routeDestinationCoordsByLocationId.size, 0);
  assert.equal(result.hotelCoordsByProviderCode.size, 0);
});
