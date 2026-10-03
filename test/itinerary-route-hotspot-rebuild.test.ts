import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryRouteHotspotRebuildService } from '../src/modules/itineraries/services/itinerary-route-hotspot-rebuild.service';

const routeVehicleRestrictions = {
  assertPersistedPlan: async () => undefined,
};

test('keeps an already-clean route as a skipped no-op', async () => {
  let transactionCount = 0;
  let parkingCount = 0;
  const service = new ItineraryRouteHotspotRebuildService({
    $transaction: async (callback: any) => { transactionCount += 1; return callback({
      dvi_itinerary_route_details: {
        findFirst: async () => ({ itinerary_route_ID: 2, excluded_hotspot_ids: [] }),
        findMany: async () => [],
      },
      dvi_itinerary_route_hotspot_details: { findMany: async () => [] },
      dvi_itinerary_plan_details: { findFirst: async () => ({ itinerary_quote_ID: 3 }) },
    }); },
  }, { rebuildParkingCharges: async () => { parkingCount += 1; } }, routeVehicleRestrictions);

  const result = await service.rebuildRouteHotspotsForDay(1, 2, 4);
  assert.equal(result.skipped, true);
  assert.equal(result.parkingChargesRebuilt, false);
  assert.equal(transactionCount, 1);
  assert.equal(parkingCount, 0);
});

test('rejects a route that is not active in the requested plan', async () => {
  const service = new ItineraryRouteHotspotRebuildService({
    $transaction: async (callback: any) => callback({
      dvi_itinerary_route_details: { findFirst: async () => null },
    }),
  }, {}, routeVehicleRestrictions);

  await assert.rejects(
    () => service.rebuildRouteHotspotsForDay(1, 2, 4),
    (error: any) => error?.message.includes('does not belong to plan'),
  );
});

test('removes manual hotspots from a reset route before rebuilding auto hotspots', async () => {
  let oldHotspotQuery: any;
  let engineInput: any[] = [];
  let engineOptions: any;
  let routeUpdateData: any;
  const activityUpdates: any[] = [];
  const hotspotUpdates: any[] = [];

  const autoHotspot = {
    route_hotspot_ID: 91,
    hotspot_ID: 901,
    itinerary_route_ID: 2,
    item_type: 4,
    hotspot_plan_own_way: 0,
    deleted: 0,
    status: 1,
    hotspot_order: 1,
  };
  const manualHotspot = {
    route_hotspot_ID: 77,
    hotspot_ID: 245,
    itinerary_route_ID: 2,
    item_type: 4,
    hotspot_plan_own_way: 1,
    deleted: 0,
    status: 1,
  };

  const service = new ItineraryRouteHotspotRebuildService(
    {
      $transaction: async (callback: any) => callback({
        dvi_itinerary_route_details: {
          findFirst: async () => ({ itinerary_route_ID: 2, excluded_hotspot_ids: [596] }),
          findMany: async () => [{ itinerary_route_ID: 2, itinerary_route_date: '2026-10-02' }],
          update: async ({ data }: any) => { routeUpdateData = data; },
        },
        dvi_itinerary_route_hotspot_details: {
          findMany: async ({ where }: any) => {
            if (where.hotspot_plan_own_way?.not === 1) {
              oldHotspotQuery = where;
              return [autoHotspot];
            }
            return [manualHotspot];
          },
          updateMany: async ({ where, data }: any) => { hotspotUpdates.push({ where, data }); },
          count: async () => 1,
        },
        dvi_itinerary_route_activity_details: {
          updateMany: async ({ where, data }: any) => { activityUpdates.push({ where, data }); },
        },
        dvi_itinerary_plan_details: {
          findFirst: async () => ({ itinerary_quote_ID: 3 }),
        },
      }),
    },
    {
      rebuildRouteHotspots: async (_tx: any, _planId: number, existing: any[], options: any) => {
        engineInput = existing;
        engineOptions = options;
        return {
          rebuildSummary: { totalRoutesProcessed: 1, totalHotspotsScheduled: 1, totalParkingRowsScheduled: 0 },
          warnings: [],
          routeRejectionSummaryByRoute: {},
        };
      },
      rebuildParkingCharges: async () => undefined,
    },
    routeVehicleRestrictions,
  );

  const result = await service.rebuildRouteHotspotsForDay(1, 2, 4);

  assert.equal(result.skipped, undefined);
  assert.deepEqual(oldHotspotQuery.hotspot_plan_own_way, { not: 1 });
  assert.deepEqual(engineInput.map((row) => row.hotspot_ID), [901]);
  assert.deepEqual(engineOptions, { scopeToRouteId: 2, protectedHotspotIds: [901] });
  assert.deepEqual(routeUpdateData.excluded_hotspot_ids, []);
  assert.equal(activityUpdates.length, 1);
  assert.equal(hotspotUpdates.length, 1);
});
