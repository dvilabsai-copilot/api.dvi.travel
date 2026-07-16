import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualHotspotBatchService } from '../src/modules/itineraries/services/itinerary-manual-hotspot-batch.service';

test('manual-hotspot batch preserves required-hotspot validation', async () => {
  const service = new ItineraryManualHotspotBatchService(null as any);
  service.setCallbacks({ normalizeManualHotspotIds: () => [] });

  await assert.rejects(
    () => service.runManualHotspotBatchWithinTransaction(null, 1, 2, [], 1),
    /At least one hotspot is required/,
  );
});

test('manual-hotspot batch preserves missing-route validation', async () => {
  const service = new ItineraryManualHotspotBatchService(null as any);
  service.setCallbacks({ normalizeManualHotspotIds: (ids: number[]) => ids });

  const tx = {
    dvi_itinerary_route_details: {
      findFirst: async () => null,
    },
  };

  await assert.rejects(
    () => service.runManualHotspotBatchWithinTransaction(tx, 1, 2, [10], 1),
    /Route not found for this itinerary plan/,
  );
});
