import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryListingService } from '../src/modules/itineraries/services/itinerary-listing.service';

function createService() {
  return new ItineraryListingService({
    dvi_agent: { findMany: async () => [] },
    dvi_itinerary_plan_details: { findMany: async () => [] },
  } as any);
}

test('listing preserves empty agent filter results', async () => {
  assert.deepEqual(await createService().getAgentsForFilter({ user: {} }), []);
});

test('listing preserves empty location filter results', async () => {
  assert.deepEqual(await createService().getLocationsForLatestFilter(), []);
});
