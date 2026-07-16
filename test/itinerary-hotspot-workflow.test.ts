import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryHotspotWorkflowService } from '../src/modules/itineraries/services/itinerary-hotspot-workflow.service';

test('hotspot availability preserves the empty result when the route is absent', async () => {
  const prisma = {
    dvi_itinerary_route_details: {
      findFirst: async () => null,
    },
  } as any;
  const service = new ItineraryHotspotWorkflowService(prisma, null as any);

  assert.deepEqual(await service.getAvailableHotspots(99), []);
});
