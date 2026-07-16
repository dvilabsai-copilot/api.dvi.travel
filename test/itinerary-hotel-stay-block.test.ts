import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelStayBlockService } from '../src/modules/itineraries/services/itinerary-hotel-stay-block.service';

test('groups consecutive same-destination route nights into one stay block', () => {
  const result = new ItineraryHotelStayBlockService().build([
    { itinerary_route_ID: 1, next_visiting_location: 'Goa', itinerary_route_date: '2026-07-17T00:00:00Z' },
    { itinerary_route_ID: 2, next_visiting_location: 'Goa', itinerary_route_date: '2026-07-18T00:00:00Z' },
    { itinerary_route_ID: 3, next_visiting_location: 'Mysuru', itinerary_route_date: '2026-07-19T00:00:00Z' },
  ], 3);

  assert.deepEqual(result, [
    { destination: 'Goa', checkInDate: '2026-07-17', checkOutDate: '2026-07-19', routeIds: [1, 2] },
    { destination: 'Mysuru', checkInDate: '2026-07-19', checkOutDate: '2026-07-20', routeIds: [3] },
  ]);
});

test('skips the final departure route when it is outside the hotel-night count', () => {
  const messages: string[] = [];
  const result = new ItineraryHotelStayBlockService().build([
    { itinerary_route_ID: 1, next_visiting_location: 'Goa', itinerary_route_date: '2026-07-17T00:00:00Z' },
    { itinerary_route_ID: 2, next_visiting_location: 'Airport', itinerary_route_date: '2026-07-18T00:00:00Z' },
  ], 1, (message) => messages.push(message));

  assert.deepEqual(result, [{ destination: 'Goa', checkInDate: '2026-07-17', checkOutDate: '2026-07-18', routeIds: [1] }]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Skipping route 2/);
});
