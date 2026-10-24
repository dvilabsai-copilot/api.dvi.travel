import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryHotspotDeletionService } from '../src/modules/itineraries/services/itinerary-hotspot-deletion.service';

test('preserves missing hotspot validation before rebuild side effects', async () => {
  const tx: any = {
    dvi_itinerary_route_hotspot_details: {
      findFirst: async () => null,
    },
  };
  const prisma: any = {
    $transaction: async (callback: (client: any) => Promise<any>) => callback(tx),
  };
  const hotspotEngine: any = {
    rebuildRouteHotspots: async () => { throw new Error('must not rebuild'); },
  };
  const service = new ItineraryHotspotDeletionService(prisma, hotspotEngine);

  await assert.rejects(
    () => service.deleteHotspot(42, 7, 99),
    (error: any) => error?.message === 'Hotspot not found',
  );
});

test('deletes dependent rows, records route exclusion and rebuilds pricing', async () => {
  const calls: string[] = [];
  const tx: any = {
    dvi_itinerary_route_hotspot_details: {
      findFirst: async ({ where }: any) => where.route_hotspot_ID === 99
        ? null
        : { hotspot_ID: 9, route_hotspot_ID: 100 },
      findMany: async () => [{ route_hotspot_ID: 100 }],
      count: async () => 0,
      updateMany: async () => { calls.push('hotspot.delete'); return { count: 1 }; },
    },
    dvi_itinerary_route_activity_details: {
      updateMany: async () => { calls.push('activity.delete'); },
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_ID: 7, excluded_hotspot_ids: [] }),
      update: async () => { calls.push('route.exclude'); },
    },
    dvi_itinerary_manual_hotspot_displacement: {
      findMany: async () => [],
      updateMany: async () => undefined,
    },
  };
  const prisma: any = {
    $transaction: async (callback: (client: any) => Promise<any>) => callback(tx),
  };
  const hotspotEngine: any = {
    rebuildRouteHotspots: async () => { calls.push('hotspot.rebuild'); return { rebuildSummary: { routes: 1 }, warnings: [] }; },
    rebuildParkingCharges: async () => { calls.push('parking.rebuild'); },
  };
  const service = new ItineraryHotspotDeletionService(prisma, hotspotEngine);
  service.setApplySameCityCrossDayOptimizerCallback(async () => { calls.push('same-city.optimize'); });
  service.setForceRebuildVehiclePricingCallback(async () => { calls.push('vehicle.rebuild'); });

  const result = await service.deleteHotspot(42, 7, 99);

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    'activity.delete',
    'hotspot.delete',
    'route.exclude',
    'hotspot.rebuild',
    'same-city.optimize',
    'parking.rebuild',
    'vehicle.rebuild',
  ]);
  assert.equal(result.parkingChargesRebuilt, true);
  assert.equal(result.vehiclePricingRebuilt, true);
});

test('freshly reselects automatic hotspots after the last manual hotspot is deleted', async () => {
  let rebuildExisting: any[] = [];
  let rebuildOptions: any = null;
  const tx: any = {
    dvi_itinerary_route_hotspot_details: {
      findFirst: async () => ({
        hotspot_ID: 9,
        route_hotspot_ID: 100,
        hotspot_plan_own_way: 1,
        item_type: 4,
        deleted: 0,
        status: 1,
      }),
      findMany: async ({ where }: any) => {
        if (where?.hotspot_ID === 9) return [{ route_hotspot_ID: 100 }];
        return [
          { itinerary_route_ID: 7, hotspot_ID: 9, item_type: 4, deleted: 0, status: 1 },
          { itinerary_route_ID: 8, hotspot_ID: 20, item_type: 4, deleted: 0, status: 1 },
        ];
      },
      count: async () => 0,
      updateMany: async () => ({ count: 1 }),
    },
    dvi_itinerary_route_activity_details: {
      updateMany: async () => undefined,
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_ID: 7, excluded_hotspot_ids: [77] }),
      update: async () => undefined,
    },
    dvi_itinerary_manual_hotspot_displacement: {
      findMany: async () => [],
      updateMany: async () => undefined,
    },
  };
  const prisma: any = {
    $transaction: async (callback: (client: any) => Promise<any>) => callback(tx),
  };
  const hotspotEngine: any = {
    rebuildRouteHotspots: async (_tx: any, _planId: number, existing: any[], options: any) => {
      rebuildExisting = existing;
      rebuildOptions = options;
      return { rebuildSummary: { routes: 1 }, warnings: [] };
    },
    rebuildParkingCharges: async () => undefined,
  };
  const service = new ItineraryHotspotDeletionService(prisma, hotspotEngine);
  service.setApplySameCityCrossDayOptimizerCallback(async () => undefined);
  service.setForceRebuildVehiclePricingCallback(async () => undefined);

  await service.deleteHotspot(42, 7, 100);

  assert.deepEqual(rebuildExisting.map((row) => row.itinerary_route_ID), [8]);
  assert.deepEqual(rebuildOptions, {
    scopeToRouteId: 7,
    preserveExistingHotspots: false,
  });
});
