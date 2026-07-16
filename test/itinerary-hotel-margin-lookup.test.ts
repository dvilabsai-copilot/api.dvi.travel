import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryHotelMarginLookupService } from '../src/modules/itineraries/services/itinerary-hotel-margin-lookup.service';

test('indexes margin masters by every supported provider key', async () => {
  let filters: any;
  const row = {
    hotel_id: 10,
    tbo_hotel_code: 'T1',
    resavenue_hotel_code: 'R1',
    hotel_code: 'H1',
  };
  const result = await new ItineraryHotelMarginLookupService().load({
    packages: [
      {
        hotels: [
          { provider: 'tbo', hotelCode: 'T1' },
          { provider: 'resavenue', hotelCode: 'R1' },
          { provider: 'hobse', hotelCode: 'H1' },
          { provider: 'axisrooms', hotelCode: '10' },
          { provider: 'staah', hotelCode: '10' },
        ],
      },
    ],
    loadMasters: async (value) => {
      filters = value;
      return [row];
    },
  });

  assert.deepEqual(filters.tboCodes, ['T1']);
  assert.deepEqual(filters.resavenueCodes, ['R1']);
  assert.deepEqual(filters.hobseCodes, ['H1']);
  assert.deepEqual(filters.axisroomsHotelIds, [10]);
  assert.deepEqual(filters.staahHotelIds, [10]);
  assert.equal(result.get('tbo|T1'), row);
  assert.equal(result.get('resavenue|R1'), row);
  assert.equal(result.get('hobse|H1'), row);
  assert.equal(result.get('axisrooms|10'), row);
  assert.equal(result.get('staah|10'), row);
});

test('skips the master query when packages contain no provider hotel codes', async () => {
  let called = false;
  const result = await new ItineraryHotelMarginLookupService().load({
    packages: [{ hotels: [{ provider: 'tbo', hotelCode: '' }] }],
    loadMasters: async () => {
      called = true;
      return [];
    },
  });

  assert.equal(called, false);
  assert.equal(result.size, 0);
});
