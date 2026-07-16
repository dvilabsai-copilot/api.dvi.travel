import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryActivityImpactService } from '../src/modules/itineraries/services/itinerary-activity-impact.service';

test('allows an activity when the route has no configured end time', async () => {
  const service = new ItineraryActivityImpactService({
    dvi_activity: { findUnique: async () => ({ activity_duration: '00:30:00' }) },
    dvi_itinerary_route_hotspot_details: { findFirst: async () => ({ hotspot_start_time: new Date('2026-07-16T10:00:00Z') }) },
    dvi_itinerary_route_details: { findFirst: async () => ({ route_end_time: null }) },
  }, {});
  const result = await service.simulateActivityImpactBeforeAdd({ planId: 1, routeId: 2, routeHotspotId: 3, hotspotId: 4, activityId: 5 });
  assert.deepEqual(result, { canAdd: true, warnings: [], optionalHotspotRouteIdsToRemove: [] });
});

test('preserves missing-activity validation before route reads', async () => {
  const service = new ItineraryActivityImpactService({
    dvi_activity: { findUnique: async () => null },
  }, {});
  await assert.rejects(
    () => service.simulateActivityImpactBeforeAdd({ planId: 1, routeId: 2, routeHotspotId: 3, hotspotId: 4, activityId: 5 }),
    (error: any) => error?.message === 'Activity not found',
  );
});
