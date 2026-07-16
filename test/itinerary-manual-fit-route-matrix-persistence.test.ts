import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitRouteMatrixPersistenceService } from '../src/modules/itineraries/services/itinerary-manual-fit-route-matrix-persistence.service';

test('preserves route projection distance and progress callback semantics', () => {
  const service = new ItineraryManualFitRouteMatrixPersistenceService();
  service.setCallbacks({
    findNearestProgressOnRoute: () => ({ distanceMeters: 125, progressRatio: 0.4 }),
  });

  assert.equal(service.distancePointToRouteMeters({ lat: 1, lng: 2 }, [[1, 2], [2, 3]]), 125);
  assert.equal(service.projectPointProgressOnRoute({ lat: 1, lng: 2 }, [[1, 2], [2, 3]]), 0.4);
});

test('returns an existing hotspot identity before issuing creation work', async () => {
  const service = new ItineraryManualFitRouteMatrixPersistenceService();
  const result = await service.ensureHotspotPlace({
    dvi_hotspot_place: {
      findFirst: async () => ({ hotspot_ID: 77 }),
    },
  }, { hotspotId: 77, hotspotName: 'Museum', hotspotLocation: 'Kochi' });

  assert.equal(result, 77);
});

test('reads route-between rejection rows with the legacy mirrored key predicate', async () => {
  let query = '';
  const service = new ItineraryManualFitRouteMatrixPersistenceService();
  const result = await service.getRouteBetweenRejectionRow({
    $queryRawUnsafe: async (sql: string) => {
      query = sql;
      return [{ rejection_code: 'MAJOR_DETOUR', rejection_reason: 'Too far' }];
    },
  }, 1, 2, 3);

  assert.deepEqual(result, { rejection_code: 'MAJOR_DETOUR', rejection_reason: 'Too far' });
  assert.match(query, /from_hotspot_id = \?/);
  assert.match(query, /to_hotspot_id = \?/);
});
