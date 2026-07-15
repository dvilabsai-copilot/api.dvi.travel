import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryExactAnchorRebuildService } from '../src/modules/itineraries/services/itinerary-exact-anchor-rebuild.service';

function createService() {
  const service = new ItineraryExactAnchorRebuildService(null as any);
  service.setCallbacks({
    enrichManualFitPreviewTimelineWithOperatingHours: (_planId, _routeId, rows) => rows,
    normalizeTravelLabelsToNextStop: (rows) => rows,
    cloneTimelineRowsForPreview: (rows) => rows,
  });
  return service;
}

test('exact-anchor rebuild preserves an empty timeline as a no-op', async () => {
  const tx = {
    dvi_itinerary_route_hotspot_details: { findMany: async () => [] },
    dvi_hotspot_place: { findFirst: async () => null, findMany: async () => [] },
    dvi_itinerary_route_details: { findFirst: async () => null },
    dvi_stored_locations: { findFirst: async () => null },
  };

  const result = await createService().buildExactAnchorSequentialTimelineAfterRemoval(tx, [], {
    removedHotspotIds: [],
    targetHotspotId: 0,
    routeId: 1,
    planId: 1,
  });

  assert.deepEqual(result, []);
});
