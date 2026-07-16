import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryHotelSecondaryProviderFetchService } from '../src/modules/itineraries/services/itinerary-hotel-secondary-provider-fetch.service';

const routes = [
  { itinerary_route_ID: 1, next_visiting_location: 'Kochi', itinerary_route_date: '2026-07-20' },
  { itinerary_route_ID: 2, next_visiting_location: 'Kochi', itinerary_route_date: '2026-07-21' },
];

test('fetches HOBSE by mapped city code and skips a departure route', async () => {
  const service = new ItineraryHotelSecondaryProviderFetchService();
  const calls: any[] = [];
  const result = await service.fetchHobse(routes, 1, { Kochi: 'H-COK' }, {
    searchHobse: async (input) => { calls.push(input); return [{ hotelCode: '1' }] as any; },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cityCode, 'H-COK');
  assert.equal(result.get(1)?.length, 1);
  assert.equal(result.has(2), false);
});

test('normalizes ResAvenue occupancy counts and sends the provider-only request', async () => {
  const service = new ItineraryHotelSecondaryProviderFetchService();
  let request: any;
  const result = await service.fetchResavenue(routes.slice(0, 1), 2, 'IN', 0, 0, -1, {
    searchResavenue: async (input) => { request = input; return []; },
  });

  assert.equal(result.get(1)?.length, 0);
  assert.equal(request.roomCount, 1);
  assert.equal(request.adultCount, 1);
  assert.equal(request.childCount, 0);
  assert.deepEqual(request.providers, ['resavenue']);
});
