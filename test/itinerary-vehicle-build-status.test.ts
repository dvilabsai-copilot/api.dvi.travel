import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryVehicleBuildStatusService } from '../src/modules/itineraries/services/itinerary-vehicle-build-status.service';

function createPrismaStub() {
  const calls: { creates: any[]; updates: any[] } = { creates: [], updates: [] };
  return {
    dvi_itinerary_vehicle_build_status: {
      create: async (args: any) => {
        calls.creates.push(args);
        return args.data;
      },
      updateMany: async (args: any) => {
        calls.updates.push(args);
        return { count: 1 };
      },
    },
    $executeRawUnsafe: async () => undefined,
    $executeRaw: async () => 1,
    $queryRaw: async () => [],
    calls,
  } as any;
}

test('audit-only vehicle build status records processing and completion in Prisma', async () => {
  const prisma = createPrismaStub();
  const service = new ItineraryVehicleBuildStatusService(prisma);
  const runId = service.createBuildRunId(41);

  await service.startRecord(41, runId, 7);
  await service.finishRecord(41, runId, 'READY', null);

  assert.equal(prisma.calls.creates.length, 1);
  assert.equal(prisma.calls.creates[0].data.status, 'PROCESSING');
  assert.equal(prisma.calls.creates[0].data.build_run_id, runId);
  assert.equal(prisma.calls.updates.length, 1);
  assert.equal(prisma.calls.updates[0].data.status, 'READY');
  assert.equal(prisma.calls.updates[0].where.build_run_id, runId);
});

test('audit-only completion creates a fallback record when a start row is absent', async () => {
  const prisma = createPrismaStub();
  prisma.dvi_itinerary_vehicle_build_status.updateMany = async () => ({ count: 0 });
  const service = new ItineraryVehicleBuildStatusService(prisma);

  await service.finishRecord(41, 'missing-run', 'FAILED', 'stage failed');

  assert.equal(prisma.calls.creates.length, 1);
  assert.equal(prisma.calls.creates[0].data.status, 'FAILED');
  assert.equal(prisma.calls.creates[0].data.error, 'stage failed');
});

test('invalid plan ids are rejected before lock acquisition', async () => {
  const service = new ItineraryVehicleBuildStatusService(createPrismaStub());
  await assert.rejects(
    () => service.withPlanBuildLock(0, async () => undefined),
    /planId is required/,
  );
});
