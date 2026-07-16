import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryMatrixSafeInsertionService } from '../src/modules/itineraries/services/itinerary-matrix-safe-insertion.service';

test('matrix-safe insertion preserves required-hotspot validation', async () => {
  await assert.rejects(
    () => new ItineraryMatrixSafeInsertionService(null as any).applyMatrixSafeManualHotspotInsertionInTx(null, {
      planId: 1,
      routeId: 1,
      selectedHotspotIds: [],
      userId: 1,
      manualInsertionFit: null,
    }),
    /At least one hotspot is required/,
  );
});
