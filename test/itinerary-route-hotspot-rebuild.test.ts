import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryRouteHotspotRebuildService } from '../src/modules/itineraries/services/itinerary-route-hotspot-rebuild.service';

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
  }, { rebuildParkingCharges: async () => { parkingCount += 1; } });

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
  }, {});

  await assert.rejects(
    () => service.rebuildRouteHotspotsForDay(1, 2, 4),
    (error: any) => error?.message.includes('does not belong to plan'),
  );
});
