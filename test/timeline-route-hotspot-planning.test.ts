import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineRouteHotspotPlanningService } from '../src/modules/itineraries/engines/helpers/timeline-route-hotspot-planning.service';

function createService(fetchSelectedHotspots: (...args: any[]) => Promise<any[]>, fetchDay1TopPrioritySourceHotspots: (...args: any[]) => Promise<any[]>, sameCityChainContinuation = true) {
  const logs: any[] = [];
  const service = new TimelineRouteHotspotPlanningService();
  service.setCallbacks({
    fetchSelectedHotspots,
    fetchDay1TopPrioritySourceHotspots,
    canonicalCityKey: (value) => String(value || '').trim().toLowerCase(),
    buildSameCityContinuationContext: () => ({ isSameCityChainContinuation: sameCityChainContinuation }),
    logBookingRule: (entry) => logs.push(entry),
  });
  return { service, logs };
}

function input(overrides: Partial<any> = {}): any {
  const route = {
    itinerary_route_ID: 10,
    location_name: 'Chennai Airport',
    next_visiting_location: 'Bengaluru',
    direct_to_next_visiting_place: 0,
  };
  return {
    tx: { dvi_itinerary_via_route_details: { findMany: async () => [] } },
    planId: 7,
    route,
    plan: { quote_id: 99 },
    routes: [route, { itinerary_route_ID: 11, location_name: 'Bengaluru', next_visiting_location: 'Bengaluru' }],
    scopedRoutes: [route, { itinerary_route_ID: 11, location_name: 'Bengaluru', next_visiting_location: 'Bengaluru' }],
    routeIndex: 1,
    previousRouteByRouteId: new Map(),
    sourceCity: 'Chennai',
    destinationCity: 'Bengaluru',
    arrivalPoint: 'Chennai',
    departurePoint: 'Bengaluru',
    currentLocationName: 'Chennai Airport',
    filteredHotspots: [{ hotspot_ID: 1 }],
    hotspotRows: [],
    carryForwardHotspots: [],
    isFirstRoute: true,
    isLastRoute: false,
    shouldDeferDay1Sightseeing: false,
    forceNoSightseeingOnThisRoute: false,
    verboseTimelineProofLogs: false,
    ...overrides,
  };
}

test('keeps the Day-1 non-direct fallback selection inside the planner', async () => {
  const calls: any[][] = [];
  let fallbackCalls = 0;
  const { service } = createService(
    async (...args) => {
      calls.push(args);
      return [];
    },
    async () => {
      fallbackCalls += 1;
      return [{ hotspot_ID: 42, hotspot_priority: 1 }];
    },
  );

  const result = await service.select(input());

  assert.deepEqual(result.selectedHotspots, [{ hotspot_ID: 42, hotspot_priority: 1 }]);
  assert.equal(calls.length, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.isDay1DifferentCities, true);
  assert.equal(result.isEligibleForDestinationReservation, false);
});

test('preserves direct-route reservation guard and clears expired carry-forward spots', async () => {
  const { service, logs } = createService(
    async () => [{ hotspot_ID: 8 }],
    async () => [],
    false,
  );
  const route = {
    itinerary_route_ID: 12,
    location_name: 'Chennai',
    next_visiting_location: 'Bengaluru',
    direct_to_next_visiting_place: 1,
  };

  const result = await service.select(input({
    route,
    routes: [route, { itinerary_route_ID: 13, location_name: 'Bengaluru', next_visiting_location: 'Mysuru' }],
    scopedRoutes: [route],
    routeIndex: 1,
    previousRouteByRouteId: new Map([[12, undefined]]),
    carryForwardHotspots: [{ hotspot_ID: 5 }],
    isFirstRoute: false,
    isLastRoute: false,
  }));

  assert.deepEqual(result.selectedHotspots, [{ hotspot_ID: 8 }]);
  assert.deepEqual(result.carryForwardHotspots, []);
  assert.equal(result.isEligibleForDestinationReservation, false);
  assert.equal(logs.some((entry) => entry.rule === 'STRICT_CARRY_FORWARD_EXPIRED'), true);
});

test('does not select hotspots when the orchestration guard disables sightseeing', async () => {
  let fetchCount = 0;
  const { service } = createService(
    async () => {
      fetchCount += 1;
      return [{ hotspot_ID: 1 }];
    },
    async () => [],
  );

  const result = await service.select(input({ forceNoSightseeingOnThisRoute: true }));

  assert.deepEqual(result.selectedHotspots, []);
  assert.equal(fetchCount, 0);
});
