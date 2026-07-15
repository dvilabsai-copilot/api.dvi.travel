import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryCancellationService } from '../src/modules/itineraries/services/itinerary-cancellation.service';

function createService() {
  return new ItineraryCancellationService(null as any, null as any, null as any, null as any);
}

test('cancellation preserves required plan validation', async () => {
  await assert.rejects(
    () => createService().cancelItinerary({ itinerary_plan_ID: 0, reason: 'test' } as any),
    /Itinerary Plan ID is required/,
  );
});

test('cancellation preserves required reason validation', async () => {
  await assert.rejects(
    () => createService().cancelItinerary({ itinerary_plan_ID: 99 } as any),
    /Cancellation reason is required/,
  );
});
