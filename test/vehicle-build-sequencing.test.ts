import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryVehicleBuildService } from '../src/modules/itineraries/services/itinerary-vehicle-build.service';

function createHarness(options: { delayMs?: number; fail?: boolean; selectedVehicleCount?: number; hasUsableVehicleDetails?: boolean; autoSelectFailure?: boolean } = {}) {
  const calls = {
    lock: 0,
    starts: 0,
    finishes: 0,
    prepare: 0,
    permits: 0,
    eligible: 0,
  };
  const activePlans = new Set<number>();
  const delayMs = options.delayMs || 0;
  const statusService: any = {
    createBuildRunId: (planId: number) => `${planId}-test-${++calls.starts}`,
    incrementScheduleCount: () => 1,
    setStatus: () => undefined,
    startRecord: async () => undefined,
    finishRecord: async () => { calls.finishes += 1; },
    getStatus: async (planId: number) => ({
      planId,
      status: 'READY',
      buildRunId: `${planId}-ready`,
      startedAt: null,
      finishedAt: null,
      updatedAt: new Date().toISOString(),
      error: null,
      eligibleCount: 3,
      vehicleDetailCount: 18,
      requestedVehicleCount: 1,
      selectedVehicleCount: options.selectedVehicleCount ?? 1,
      hasUsableVehicleDetails: options.hasUsableVehicleDetails ?? true,
      isLatestBuildReady: true,
      statusSource: 'memory',
    }),
    withPlanBuildLock: async (planId: number, work: () => Promise<unknown>) => {
      calls.lock += 1;
      if (activePlans.has(planId)) throw new Error('VEHICLE_BUILD_IN_PROGRESS');
      activePlans.add(planId);
      try {
        return await work();
      } finally {
        activePlans.delete(planId);
      }
    },
  };
  const prisma: any = {
    $transaction: async (work: (tx: any) => Promise<unknown>) => work({}),
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'DVI-TEST' }),
    },
    dvi_itinerary_plan_vehicle_details: {
      findMany: async () => vehicleRows,
    },
    dvi_itinerary_plan_vendor_eligible_list: {
      findMany: async (args: any) => {
        if (options.autoSelectFailure) throw new Error('auto-selection failed');
        if (args?.where?.itineary_plan_assigned_status === 1) {
          return (options.selectedVehicleCount ?? 1) > 0 ? [{ vehicle_type_id: 1 }] : [];
        }
        return [];
      },
      updateMany: async () => undefined,
    },
    dvi_itinerary_plan_vendor_vehicle_details: {
      count: async () => (options.hasUsableVehicleDetails === false ? 0 : 1),
    },
    $queryRawUnsafe: async () => [],
  };
  const vehiclesEngine: any = {
    rebuildPlanVehicles: async () => {
      calls.prepare += 1;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (options.fail) throw new Error('vehicle stage failed');
    },
  };
  const routeEngine: any = {
    rebuildPermitCharges: async () => { calls.permits += 1; },
  };
  const itineraryVehiclesEngine: any = {
    rebuildEligibleVendorList: async () => {
      calls.eligible += 1;
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    },
  };
  const service = new ItineraryVehicleBuildService(
    prisma,
    routeEngine,
    vehiclesEngine,
    itineraryVehiclesEngine,
    statusService,
  );
  return { service, calls };
}

const vehicleRows = [{ vehicle_type_id: 1, vehicle_count: 1 }];

test('creation build is awaited, rebuilds permits inside the build, and invokes exactly one build', async () => {
  const { service, calls } = createHarness({ delayMs: 20 });
  let resolved = false;
  const resultPromise = service.buildVehiclesSynchronously(9965, vehicleRows, 1)
    .then(() => { resolved = true; });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(resolved, false);
  await resultPromise;
  assert.equal(resolved, true);
  assert.equal(calls.lock, 1);
  assert.equal(calls.prepare, 1);
  assert.equal(calls.eligible, 1);
  assert.equal(calls.permits, 1);
});

test('each explicit synchronous request performs one permit and one vehicle build', async () => {
  const manual = createHarness();
  await manual.service.buildVehiclesSynchronously(9965, vehicleRows, 1);
  assert.equal(manual.calls.permits, 1);
  assert.equal(manual.calls.prepare, 1);
});

test('same-plan builds have one database ownership slot while different plans proceed', async () => {
  const samePlan = createHarness({ delayMs: 25 });
  const first = samePlan.service.buildVehiclesSynchronously(9965, vehicleRows, 1);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await assert.rejects(
    () => samePlan.service.buildVehiclesSynchronously(9965, vehicleRows, 1),
    /VEHICLE_BUILD_IN_PROGRESS/,
  );
  await first;
  assert.equal(samePlan.calls.prepare, 1);

  const differentPlans = createHarness({ delayMs: 10 });
  await Promise.all([
    differentPlans.service.buildVehiclesSynchronously(9965, vehicleRows, 1),
    differentPlans.service.buildVehiclesSynchronously(9966, vehicleRows, 1),
  ]);
  assert.equal(differentPlans.calls.prepare, 2);
});

test('vehicle build failures finish the owned run and do not create a detached retry', async () => {
  const { service, calls } = createHarness({ fail: true });
  await assert.rejects(
    () => service.buildVehiclesSynchronously(9965, vehicleRows, 1),
    /vehicle stage failed/,
  );
  assert.equal(calls.lock, 1);
  assert.equal(calls.prepare, 1);
});

test('usable rows with a valid selection reach READY', async () => {
  const { service } = createHarness({ selectedVehicleCount: 1 });
  const result = await service.buildVehiclesSynchronously(9965, vehicleRows, 1, 'DVI-TEST');
  assert.equal(result.status.status, 'READY');
});

test('usable rows without the required selection fail instead of reaching READY', async () => {
  const { service } = createHarness({ selectedVehicleCount: 0 });
  await assert.rejects(
    () => service.buildVehiclesSynchronously(9965, vehicleRows, 1, 'DVI-TEST'),
    /Vehicle selection is incomplete/,
  );
});

test('auto-selection exceptions fail the owned build', async () => {
  const { service } = createHarness({ autoSelectFailure: true });
  await assert.rejects(
    () => service.buildVehiclesSynchronously(9965, vehicleRows, 1, 'DVI-TEST'),
    /auto-selection failed/,
  );
});

test('sync endpoint no-usable-row failure performs one destructive build and one permit rebuild', async () => {
  const { service, calls } = createHarness({ hasUsableVehicleDetails: false, selectedVehicleCount: 0 });
  await assert.rejects(
    () => service.buildVehiclesSync(9965, { user: { userId: 1 } }),
    /Vehicle pricing failed/,
  );
  assert.equal(calls.prepare, 1);
  assert.equal(calls.permits, 1);
  assert.equal(calls.eligible, 1);
});
