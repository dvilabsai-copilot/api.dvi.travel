import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualHotspotMatrixService } from '../src/modules/itineraries/services/itinerary-manual-hotspot-matrix.service';

function createService() {
  const service = new ItineraryManualHotspotMatrixService(null as any);
  service.setCallbacks({
    deriveLooseCityKey: (value) => value.trim().toLowerCase(),
    normalizeLocationText: (value) => value.trim().toLowerCase(),
  });
  return service;
}

test('manual hotspot matrix preserves plan validation', async () => {
  await assert.rejects(
    () => createService().buildMissingManualHotspotMatrix({ planId: 0, routeId: 1, candidateHotspotId: 1 }),
    /planId must be a positive integer/,
  );
});

test('manual hotspot matrix preserves route validation', async () => {
  await assert.rejects(
    () => createService().buildMissingManualHotspotMatrix({ planId: 1, routeId: 0, candidateHotspotId: 1 }),
    /routeId must be a positive integer/,
  );
});
