import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryVehicleBuildStatusService } from '../src/modules/itineraries/services/itinerary-vehicle-build-status.service';

function createPrismaStub() {
  const raw = (() => []) as any;
  raw.mockResult = 1;

  return {
    $executeRawUnsafe: async () => undefined,
    $executeRaw: async () => raw.mockResult,
    $queryRaw: async () => [],
    dvi_itinerary_plan_vendor_eligible_list: {
      count: async () => 0,
    },
    dvi_itinerary_plan_vendor_vehicle_details: {
      count: async () => 0,
      findFirst: async () => null,
    },
    dvi_itinerary_plan_vehicle_details: {
      count: async () => 0,
    },
    dvi_itinerary_route_details: {
      count: async () => 0,
    },
  } as any;
}

test('vehicle build status rejects an invalid plan id', async () => {
  const service = new ItineraryVehicleBuildStatusService(createPrismaStub());

  await assert.rejects(
    () => service.getStatus(0),
    /planId is required/,
  );
});

test('vehicle build status preserves the pending fallback contract', async () => {
  const service = new ItineraryVehicleBuildStatusService(createPrismaStub());

  const status = await service.getStatus(41);

  assert.deepEqual(
    {
      planId: status.planId,
      status: status.status,
      statusSource: status.statusSource,
      hasUsableVehicleDetails: status.hasUsableVehicleDetails,
    },
    {
      planId: 41,
      status: 'PENDING',
      statusSource: 'derived',
      hasUsableVehicleDetails: false,
    },
  );
});

test('vehicle build status exposes a processing record after scheduling', async () => {
  const prisma = createPrismaStub();
  const service = new ItineraryVehicleBuildStatusService(prisma);
  const runId = service.createBuildRunId(41);

  await service.startRecord(41, runId, 7);
  const status = await service.getStatus(41);

  assert.equal(status.status, 'PROCESSING');
  assert.equal(status.statusSource, 'memory');
  assert.equal(status.buildRunId, runId);
  assert.equal(service.incrementScheduleCount(41), 1);
  assert.equal(service.incrementScheduleCount(41), 2);
});
