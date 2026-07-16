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
      deleteMany: async () => { calls.push('hotspot.delete'); return { count: 1 }; },
    },
    dvi_itinerary_route_activity_details: {
      deleteMany: async () => { calls.push('activity.delete'); },
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_ID: 7, excluded_hotspot_ids: [] }),
      update: async () => { calls.push('route.exclude'); },
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
  service.setForceRebuildVehiclePricingCallback(async () => { calls.push('vehicle.rebuild'); });

  const result = await service.deleteHotspot(42, 7, 99);

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    'activity.delete',
    'hotspot.delete',
    'route.exclude',
    'hotspot.rebuild',
    'parking.rebuild',
    'vehicle.rebuild',
  ]);
  assert.equal(result.parkingChargesRebuilt, true);
  assert.equal(result.vehiclePricingRebuilt, true);
});
