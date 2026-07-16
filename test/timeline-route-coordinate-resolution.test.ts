import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineRouteCoordinateResolutionService } from '../src/modules/itineraries/engines/helpers/timeline-route-coordinate-resolution.service';

test('uses route city labels and stored coordinates without replacing route precedence', async () => {
  const service = new TimelineRouteCoordinateResolutionService();
  const result = await service.resolve({
    tx: {
      dvi_stored_locations: {
        findFirst: async () => ({
          source_location_lattitude: '13.08',
          source_location_longitude: '80.27',
          destination_location_lattitude: '12.62',
          destination_location_longitude: '80.19',
          source_location: 'Stored Chennai',
          destination_location: 'Stored Mahabalipuram',
        }),
      },
    },
    route: { location_name: 'Chennai|Old Label', next_visiting_location: 'Mahabalipuram', location_id: 3 },
    plan: { departure_location: 'Airport' },
    hasUsableCoords: (value) => Boolean(value && value.lat !== 0 && value.lon !== 0),
    resolvePlaceCoords: async () => { throw new Error('fallback should not run'); },
  });

  assert.equal(result.currentLocationName, 'Chennai');
  assert.equal(result.sourceCity, 'Chennai');
  assert.equal(result.destinationCity, 'Mahabalipuram');
  assert.deepEqual(result.currentCoords, { lat: 13.08, lon: 80.27 });
  assert.deepEqual(result.destCityCoords, { lat: 12.62, lon: 80.19 });
});

test('resolves missing stored coordinates through source and destination place fallbacks', async () => {
  const fallbackCalls: string[] = [];
  const result = await new TimelineRouteCoordinateResolutionService().resolve({
    tx: { dvi_stored_locations: { findFirst: async () => null } },
    route: { location_name: 'Chennai', next_visiting_location: 'Bengaluru', location_id: 0 },
    plan: { departure_location: 'Airport' },
    hasUsableCoords: () => false,
    resolvePlaceCoords: async (_tx, place, side) => {
      fallbackCalls.push(`${side}:${place}`);
      return side === 'source' ? { lat: 13, lon: 80 } : { lat: 12, lon: 77 };
    },
  });

  assert.deepEqual(result.currentCoords, { lat: 13, lon: 80 });
  assert.deepEqual(result.destCityCoords, { lat: 12, lon: 77 });
  assert.deepEqual(fallbackCalls, ['source:Chennai', 'destination:Bengaluru']);
});
