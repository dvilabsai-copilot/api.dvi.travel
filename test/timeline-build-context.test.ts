import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineBuildContextService } from '../src/modules/itineraries/engines/helpers/timeline-build-context.service';

function createDataAccess() {
  return {
    loadPlan: async () => ({ itinerary_plan_ID: 7, quote_id: 'Q-7' }),
    loadRoutes: async () => [
      { itinerary_route_ID: 1, itinerary_route_date: new Date('2026-07-16') },
      { itinerary_route_ID: 2, itinerary_route_date: new Date('2026-07-17') },
    ],
    loadAllActiveHotspots: async () => [
      { hotspot_ID: 10, hotspot_name: 'Open', hotspot_location: 'A', hotspot_priority: 1 },
      { hotspot_ID: 20, hotspot_name: 'Closed', hotspot_location: 'B', hotspot_priority: 2 },
    ],
    loadAllActiveTimings: async () => [{ hotspot_ID: 10, hotspot_timing_day: 1 }],
    buildTimingMap: (rows: any[]) => new Map([[10, new Map([[1, rows]])]]),
  };
}

test('loads scoped routes, maps hotspots and filters permanently closed rows', async () => {
  const contextService = new TimelineBuildContextService(createDataAccess() as any);
  const context = await contextService.load({ dvi_global_settings: { findFirst: async () => null } }, 7, 2);
  assert.ok(context);
  assert.deepEqual(context.scopedRoutes.map((route) => route.itinerary_route_ID), [2]);
  assert.equal(context.previousRouteByRouteId.get(2)?.itinerary_route_ID, 1);
  assert.equal(context.hotspotMap.get(10)?.hotspot_name, 'Open');
  assert.deepEqual(context.filteredHotspots.map((hotspot) => hotspot.hotspot_ID), [10, 20]);
});

test('preserves global settings and closed-hotspot evidence callbacks', async () => {
  const events: any[] = [];
  const contextService = new TimelineBuildContextService(createDataAccess() as any);
  contextService.setCallbacks({
    setGlobalSettings: (settings) => events.push(['settings', settings]),
    isHotspotClosedOnAllDays: (_timings, hotspotId) => hotspotId === 20,
    logBookingRule: (payload) => events.push(['rule', payload]),
  });
  const context = await contextService.load({ dvi_global_settings: { findFirst: async () => ({ buffer: 5 }) } }, 7);
  assert.ok(context);
  assert.deepEqual(context.filteredHotspots.map((hotspot) => hotspot.hotspot_ID), [10]);
  assert.equal(events[0][0], 'settings');
  assert.equal(events[1][1].closedHotspotCount, 1);
});
