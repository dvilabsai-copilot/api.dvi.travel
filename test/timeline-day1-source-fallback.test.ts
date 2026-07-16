import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineDay1SourceFallbackService } from '../src/modules/itineraries/engines/helpers/timeline-day1-source-fallback.service';

const service = new TimelineDay1SourceFallbackService();
service.setCallbacks({
  normalizeCityName: (value) => value.trim().toLowerCase(),
  hotspotLocationMatchesCity: (location, city) =>
    String(location || '').split('|').some((part) => part.trim().toLowerCase() === String(city || '').trim().toLowerCase()),
});

test('selects source-city hotspots by priority, distance and limit', async () => {
  const tx = {
    dvi_itinerary_route_details: {
      findFirst: async () => ({ location_id: 5 }),
    },
    dvi_stored_locations: {
      findFirst: async () => ({ source_location_lattitude: 13, source_location_longitude: 80 }),
    },
    dvi_hotspot_place: {
      findMany: async () => [
        { hotspot_ID: 1, hotspot_name: 'Far priority', hotspot_location: 'Chennai', hotspot_priority: 1, hotspot_latitude: 14, hotspot_longitude: 80 },
        { hotspot_ID: 2, hotspot_name: 'Near priority', hotspot_location: 'Chennai', hotspot_priority: 1, hotspot_latitude: 13.01, hotspot_longitude: 80 },
        { hotspot_ID: 3, hotspot_name: 'Other city', hotspot_location: 'Bengaluru', hotspot_priority: 1, hotspot_latitude: 13, hotspot_longitude: 80 },
        { hotspot_ID: 4, hotspot_name: 'Lower priority', hotspot_location: 'Chennai', hotspot_priority: 2, hotspot_latitude: 13, hotspot_longitude: 80 },
      ],
    },
  };

  const result = await service.fetch(tx as any, 7, 11, 'Chennai', 'Bengaluru', new Set(), 2);
  assert.deepEqual(result.map((hotspot) => hotspot.hotspot_ID), [2, 1]);
  assert.equal(result[0].matched_bucket, 'source_fallback');
});

test('preserves exclusion, zero-priority predicate and missing-route fallback behavior', async () => {
  let hotspotWhere: any;
  const tx = {
    dvi_itinerary_route_details: {
      findFirst: async () => ({ location_id: null }),
    },
    dvi_hotspot_place: {
      findMany: async (args: any) => {
        hotspotWhere = args.where;
        return [{ hotspot_ID: 9, hotspot_location: 'Chennai', hotspot_priority: 0 }];
      },
    },
  };

  const result = await service.fetch(tx as any, 7, 11, 'Chennai', 'Bengaluru', new Set([9]), 3, true);
  assert.deepEqual(result, []);
  assert.deepEqual(hotspotWhere, { deleted: 0, status: 1 });

  const missingRoute = {
    dvi_itinerary_route_details: { findFirst: async () => null },
  };
  assert.deepEqual(await service.fetch(missingRoute as any, 7, 11, 'Chennai', 'Bengaluru'), []);
});
