import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualHotspotMutationService } from '../src/modules/itineraries/services/itinerary-manual-hotspot-mutation.service';

test('manual hotspot mutation preserves add response projection', async () => {
  const service = new ItineraryManualHotspotMutationService(
    { dvi_itinerary_route_hotspot_details: { findFirst: async () => null } } as any,
    null as any,
  );
  (service as any).applyManualHotspotsBatch = async () => ({
    resolution: { scheduledManualHotspots: [{ id: 7, name: 'Falls', visitTime: '10:00 - 10:30' }] },
    newHotspot: { text: 'Falls' },
    fullTimeline: [],
  });

  const result = await service.addManualHotspot(1, 2, 7, 1);

  assert.equal(result.hotspotId, 7);
  assert.equal(result.hotspotName, 'Falls');
  assert.equal(result.insertedHotspot.startTime, '10:00');
  assert.equal(result.insertedHotspot.endTime, '10:30');
});
