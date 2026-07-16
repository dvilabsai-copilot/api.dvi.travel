import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotelDetailsCacheService } from '../src/modules/itineraries/services/itinerary-hotel-details-cache.service';

test('separates base and route-specific room cache keys and clears both', () => {
  const cache = new ItineraryHotelDetailsCacheService();
  cache.setRoomDetails('Q1', { value: 'base' });
  cache.setRoomDetails('Q1', { value: 'route' }, 2);
  assert.deepEqual(cache.getRoomDetails('Q1'), { value: 'base' });
  assert.deepEqual(cache.getRoomDetails('Q1', 2), { value: 'route' });
  assert.equal(cache.getStats().size, 2);
  cache.clearForQuote('Q1');
  assert.equal(cache.getStats().size, 0);
});

test('stores and reports general hotel details independently', () => {
  const cache = new ItineraryHotelDetailsCacheService();
  cache.setHotelDetails('Q2', { hotels: 3 });
  assert.deepEqual(cache.getHotelDetails('Q2'), { hotels: 3 });
  assert.deepEqual(cache.getStats(), { size: 1, entries: ['details:Q2'] });
});
