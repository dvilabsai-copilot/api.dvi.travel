import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryPlanPersistenceService } from '../src/modules/itineraries/services/itinerary-plan-persistence.service';

function createService() {
  return new ItineraryPlanPersistenceService(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );
}

test('reusable template save preserves required plan validation', async () => {
  await assert.rejects(
    () => createService().saveReusableTemplate({ planId: 0 }, 1),
    /planId is required/,
  );
});

test('reusable template lookup preserves required location and day validation', async () => {
  await assert.rejects(
    () => createService().getReusableTemplateMatch('', 'Chennai', 0),
    /sourceLocation, destinationLocation, and dayCount are required/,
  );
});
