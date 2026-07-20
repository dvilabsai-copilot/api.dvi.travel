import test from 'node:test';
import assert from 'node:assert/strict';
import { RouteVehicleRestrictionService } from '../src/modules/route-vehicle-restrictions/route-vehicle-restriction.service';

test('derives ghat entry time from the stored route duration profile', async () => {
  const service = new RouteVehicleRestrictionService({} as any);
  const db = {
    dvi_stored_location_via_routes: {
      findMany: async () => [{
        via_route_location_lattitude: '11.3371457',
        via_route_location_longitude: '76.8701544',
        distance_from_source_to_via_route: '51.7',
        duration_from_source_to_via_route: '47 mins',
      }],
    },
  };

  const result = await (service as any).routeDurationToBoundary(
    {
      location_ID: 15638,
      distance: 85.2,
      duration: '2 Hours 46 Min',
    },
    {
      latitude: 11.3371457,
      longitude: 76.8701544,
      detectionRadiusMetres: 700,
    },
    db,
  );

  assert.equal(result.distanceKm, 51.7);
  assert.equal(result.durationMinutes, 101);
});
