import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HotelTravelBuilder } from '../src/modules/itineraries/engines/helpers/hotel-travel.builder';

test('hotel travel arrival is calculated from the actual start plus route duration', async () => {
  const builder = new HotelTravelBuilder();
  const travelBuilder = (builder as any).travelBuilder;

  travelBuilder.distanceHelper = {
    fromSourceAndDestination: async () => ({
      distanceKm: 226.49,
      travelTime: '05:32:00',
      bufferTime: '00:00:00',
    }),
  };

  const result = await builder.buildToHotel({} as any, {
    planId: 12032,
    routeId: 1,
    order: 1,
    startTime: '13:00:00',
    travelLocationType: 2,
    userId: 1,
    sourceLocationName: 'Bangalore, International Airport',
    destinationLocationName: 'Rio Meridian Hotel',
  });

  assert.equal(result.row.hotspot_start_time instanceof Date, true);
  assert.equal(result.row.hotspot_end_time instanceof Date, true);
  assert.equal(result.nextTime, '18:32:00');
});
