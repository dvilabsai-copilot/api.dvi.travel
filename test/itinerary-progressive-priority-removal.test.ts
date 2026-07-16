import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryProgressivePriorityRemovalService } from '../src/modules/itineraries/services/itinerary-progressive-priority-removal.service';

test('progressive priority removal preserves an empty-route no-op result', async () => {
  const service = new ItineraryProgressivePriorityRemovalService();
  service.setCallbacks({ deriveLooseCityKey: () => '' });
  const tx = {
    dvi_itinerary_route_hotspot_details: { findMany: async () => [] },
    dvi_hotspot_place: { findFirst: async () => null },
  };

  const result = await service.resolveProgressivePriorityRemovalForManualFitInTx(tx, {
    planId: 1,
    routeId: 2,
    selectedHotspotId: 10,
    selectedManualPriority: 4,
    currentTimeline: [],
    dayEndMinutes: 1200,
  });

  assert.equal(result.resolved, false);
  assert.deepEqual(result.candidateHotspots, []);
  assert.deepEqual(result.finalTimeline, []);
});
