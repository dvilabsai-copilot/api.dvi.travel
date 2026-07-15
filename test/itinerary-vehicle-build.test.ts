import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryVehicleBuildService } from '../src/modules/itineraries/services/itinerary-vehicle-build.service';

function createService() {
  return new ItineraryVehicleBuildService(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );
}

test('vehicle build permit sync preserves the required plan id validation', async () => {
  await assert.rejects(
    () => createService().buildPermitsSync(0, {}),
    /planId is required/,
  );
});

test('vehicle build trigger preserves the required plan id validation', async () => {
  await assert.rejects(
    () => createService().triggerVehicleBuild(0, {}),
    /planId is required/,
  );
});
