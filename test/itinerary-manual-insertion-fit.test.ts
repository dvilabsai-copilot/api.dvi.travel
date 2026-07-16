import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualInsertionFitService } from '../src/modules/itineraries/services/itinerary-manual-insertion-fit.service';

test('manual insertion fit preserves missing city-matrix fallback semantics', async () => {
  const service = new ItineraryManualInsertionFitService();
  service.setCallbacks({
    classifyManualHotspotCityContext: () => 'UNKNOWN',
  });

  const tx = {
    dvi_itinerary_route_details: { findFirst: async () => null },
    dvi_itinerary_route_hotspot_details: { findMany: async () => [] },
    dvi_hotspot_place: { findFirst: async () => null },
    $queryRawUnsafe: async () => [],
  };

  const result = await service.buildManualInsertionFit(
    tx,
    1,
    2,
    10,
    'Candidate',
  );

  assert.equal(result.requiresMatrixBuild, true);
  assert.equal(result.chosenSlotSource, 'NO_MATRIX_DATA');
  assert.deepEqual(result.allSlotResults, []);
});
