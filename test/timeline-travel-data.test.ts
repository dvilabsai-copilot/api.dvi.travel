import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineTravelDataService } from '../src/modules/itineraries/engines/helpers/timeline-travel-data.service';

const distanceHelper = {
  fromSourceAndDestination: async () => ({
    travelTime: '00:30:00',
    bufferTime: '00:10:00',
  }),
} as any;

const service = new TimelineTravelDataService(distanceHelper);

test('resolves hotspot and hotel location data with the original fallback fields', async () => {
  const tx = {
    dvi_hotspot_place: {
      findFirst: async () => ({ hotspot_city: 'Mysuru' }),
    },
    dvi_itinerary_plan_hotel_details: {
      findFirst: async () => ({ hotel_city: 'Coorg' }),
    },
  };
  assert.equal(await service.getHotspotLocationName(tx as any, 12), 'Mysuru');
  assert.equal(await service.getHotelLocationNameForRoute(tx as any, 1, 2), 'Coorg');
});

test('resolves preferred stored-location coordinates and preserves destination fallback order', async () => {
  const tx = {
    $queryRaw: async () => [{
      source_location_lattitude: 11.1,
      source_location_longitude: 75.2,
      destination_location_lattitude: 12.3,
      destination_location_longitude: 76.4,
    }],
  };
  assert.deepEqual(await service.resolvePlaceCoords(tx as any, 'Mysuru', 'destination'), { lat: 12.3, lon: 76.4 });
  assert.equal(await service.resolvePlaceCoords({ $queryRaw: async () => [] } as any, 'Hotel'), undefined);
});

test('calculates pure travel time and projected arrival using the shared distance helper', async () => {
  assert.equal(await service.calculateTravelTime(tx as any, 'Mysuru', 'Coorg'), '00:30:00');
  const projected = await service.calculateProjectedArrivalToRouteDestination(
    tx as any,
    { next_visiting_location: 'Coorg' },
    'Mysuru',
    3600,
  );
  assert.deepEqual(projected, { projectedArrivalSeconds: 6000, travelToDestSeconds: 2400 });
});

const tx = { $queryRaw: async () => [] };
