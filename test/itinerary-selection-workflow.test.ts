import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerarySelectionWorkflowService } from '../src/modules/itineraries/services/itinerary-selection-workflow.service';

function createService(prisma: any = {}) {
  return new ItinerarySelectionWorkflowService(
    prisma,
    null as any,
    null as any,
    null as any,
  );
}

test('hotel availability preserves the empty result when the route is absent', async () => {
  const service = createService({
    dvi_itinerary_route_details: { findFirst: async () => null },
  });

  assert.deepEqual(await service.getAvailableHotels(99), []);
});

test('vehicle slab selection preserves required-field validation', async () => {
  await assert.rejects(
    () => createService().selectVehicleSlab({ planId: 0, vehicleTypeId: 0 }),
    /planId, vehicleTypeId, vendorEligibleId and timeLimitId are required/,
  );
});

test('vehicle slab auto-selection preserves plan validation', async () => {
  await assert.rejects(
    () => createService().autoSelectVehicleSlabs({ planId: 0 }),
    /planId is required/,
  );
});
