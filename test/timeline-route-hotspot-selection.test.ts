import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineRouteHotspotSelectionService } from '../src/modules/itineraries/engines/helpers/timeline-route-hotspot-selection.service';

const service = new TimelineRouteHotspotSelectionService({
  fromSourceAndDestination: async () => ({ distanceKm: '1 km' }),
} as any);

service.setCallbacks({
  logTimeline: () => undefined,
  logBookingRule: () => undefined,
  logHotspotCandidateEvaluation: () => undefined,
  canonicalCityKey: (value: string) => String(value || '').trim().toLowerCase(),
  hotspotLocationMatchesCity: (location, city) =>
    String(location || '').split('|').some((part) => part.trim().toLowerCase() === String(city || '').trim().toLowerCase()),
  hotspotNameMatchesLocation: (hotspot, location) =>
    String(hotspot?.hotspot_name || '').toLowerCase().includes(String(location || '').toLowerCase()),
  routeSpecificHotspotMatchesRouteChain: (from: string, to: string, legs: string[]) => {
    const fromIndex = legs.findIndex((leg) => leg.toLowerCase() === from.toLowerCase());
    const toIndex = legs.findIndex((leg) => leg.toLowerCase() === to.toLowerCase());
    return { matches: fromIndex >= 0 && toIndex > fromIndex, fromIndex, toIndex };
  },
  routeMovementOrder: (fromIndex: number, toIndex: number) => fromIndex * 100 + toIndex,
  buildRouteLegs: (source: string, via: string[], destination: string) => [source, ...via, destination],
  resolvePlaceCoords: async () => undefined,
  getTravelLocationType: () => 2,
});

test('preserves route bucket precedence and final projection', async () => {
  const tx = {
    dvi_itinerary_route_details: {
      findFirst: async () => ({
        location_name: 'Chennai',
        next_visiting_location: 'Bengaluru',
        itinerary_route_date: new Date('2026-07-16T00:00:00Z'),
        direct_to_next_visiting_place: 0,
      }),
    },
    dvi_hotspot_timing: { findMany: async () => [] },
    dvi_itinerary_via_route_details: { findMany: async () => [] },
  };
  const hotspots = [
    { hotspot_ID: 1, hotspot_name: 'Source stop', hotspot_location: 'Chennai', hotspot_priority: 2 },
    { hotspot_ID: 2, hotspot_name: 'Destination stop', hotspot_location: 'Bengaluru', hotspot_priority: 3 },
    { hotspot_ID: 3, hotspot_name: 'Corridor stop', hotspot_location: 'Chennai', hotspot_to_location: 'Bengaluru', hotspot_priority: 1 },
  ];

  const result = await service.fetch(tx as any, 7, 11, hotspots);
  assert.deepEqual(result.map((hotspot) => hotspot.hotspot_ID), [1, 3, 2]);
  assert.deepEqual(result.map((hotspot) => hotspot.matched_bucket), ['source', 'en_route', 'destination']);
  assert.equal(result[1].__route_chain_from_index, 0);
  assert.equal(result[1].__route_chain_to_index, 1);
});

test('preserves route-context and excluded-candidate no-op behavior', async () => {
  const missingContext = {
    dvi_itinerary_route_details: { findFirst: async () => ({ location_name: '', next_visiting_location: '' }) },
  };
  assert.deepEqual(await service.fetch(missingContext as any, 7, 11, []), []);

  const tx = {
    dvi_itinerary_route_details: {
      findFirst: async () => ({ location_name: 'Chennai', next_visiting_location: 'Bengaluru', excluded_hotspot_ids: [9] }),
    },
    dvi_hotspot_timing: { findMany: async () => [] },
    dvi_itinerary_via_route_details: { findMany: async () => [] },
  };
  const result = await service.fetch(tx as any, 7, 11, [
    { hotspot_ID: 9, hotspot_name: 'Excluded', hotspot_location: 'Chennai', hotspot_priority: 1 },
  ]);
  assert.deepEqual(result, []);
});
