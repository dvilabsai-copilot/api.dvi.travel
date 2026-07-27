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

test('vehicle build sync preserves the required plan id validation', async () => {
  await assert.rejects(
    () => createService().buildVehiclesSync(0, {}),
    /planId is required/,
  );
});
