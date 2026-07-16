import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryHotelPreferenceFilterService } from '../src/modules/itineraries/services/itinerary-hotel-preference-filter.service';

const hotel = (overrides: any = {}) => ({
  hotelCode: '1',
  hotelName: 'Hotel',
  rating: 4,
  price: 100,
  mealPlan: 'Room Only',
  roomTypes: [{ roomName: 'CP', price: 140 }],
  provider: 'tbo',
  ...overrides,
}) as any;

test('filters by category and preserves unknown-category ResAvenue hotels', () => {
  const service = new ItineraryHotelPreferenceFilterService();
  const result = service.apply(
    new Map([[1, [hotel(), hotel({ hotelCode: '2', rating: 3 }), hotel({ hotelCode: '3', provider: 'resavenue', rating: undefined, category: undefined })]]]),
    [4],
    null,
  );

  assert.deepEqual(result.get(1)?.map((item) => item.hotelCode), ['1', '3']);
});

test('aligns a matching meal-plan room and rejects known mismatches', () => {
  const service = new ItineraryHotelPreferenceFilterService();
  const result = service.apply(
    new Map([[1, [hotel({ mealPlan: 'CP' }), hotel({ hotelCode: '2', mealPlan: 'EP', roomTypes: [] })]]]),
    [],
    'CP',
  );

  assert.equal(result.get(1)?.length, 1);
  assert.equal(result.get(1)?.[0].hotelCode, '1');
  assert.equal(result.get(1)?.[0].mealPlan, 'CP');
  assert.equal(result.get(1)?.[0].price, 140);
});
