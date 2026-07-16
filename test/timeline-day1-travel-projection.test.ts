import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineDay1TravelProjectionService } from '../src/modules/itineraries/engines/helpers/timeline-day1-travel-projection.service';

async function project(overrides: Partial<any> = {}) {
  const logs: any[] = [];
  const resolvedCoords = { lat: 13.08, lon: 80.27 };
  const input: any = {
    tx: {},
    route: { itinerary_route_ID: 10 },
    hotspot: { hotspot_ID: 1, hotspot_priority: 1, matched_bucket: 'source', hotspot_distance: 2 },
    hotspotData: { hotspot_location: 'Chennai' },
    currentLocationName: 'Source hotel',
    hotspotLocationName: 'Chennai',
    currentCoords: undefined,
    sourceCity: 'Bengaluru',
    destCoords: { lat: 13.08, lon: 80.27 },
    destCityCoords: { lat: 13.08, lon: 80.27 },
    currentTime: '08:00:00',
    hotspotDuration: '01:00:00',
    routeStartSeconds: 8 * 3600,
    routeEndSeconds: 18 * 3600,
    routeEndTime: '18:00:00',
    isLastRoute: false,
    tracePhpIncludeFlow: false,
    distanceCalcCount: 4,
    hasUsableCoords: (coords: any) => Boolean(coords?.lat && coords?.lon),
    resolvePlaceCoords: async () => resolvedCoords,
    calculateTravelTimeWithCoords: async () => '01:00:00',
    calculateProjectedArrivalToRouteDestination: async () => ({
      projectedArrivalSeconds: 11 * 3600,
      travelToDestSeconds: 3600,
    }),
    logHotspotCandidateEvaluation: (entry: any) => logs.push(entry),
    ...overrides,
  };
  return { result: await new TimelineDay1TravelProjectionService().project(input), logs };
}

test('resolves source coordinates and preserves absolute and wrapped visit timing', async () => {
  const { result, logs } = await project();

  assert.equal(logs.length, 0);
  assert.deepEqual(result, {
    currentCoords: { lat: 13.08, lon: 80.27 },
    distanceCalcCount: 5,
    travelTimeToHotspot: '01:00:00',
    travelDurationSeconds: 3600,
    currentTimeSeconds: 8 * 3600,
    hotspotDurationSeconds: 3600,
    absoluteVisitStartSeconds: 9 * 3600,
    absoluteVisitEndSeconds: 10 * 3600,
    timeAfterTravel: '09:00:00',
    timeAfterSightseeing: '10:00:00',
    projectedArrivalSeconds: 11 * 3600,
    travelToDestSeconds: 3600,
  });
});

test('rejects a last-route hotspot that ends after the route deadline', async () => {
  const { result, logs } = await project({
    isLastRoute: true,
    routeEndSeconds: 9 * 3600 + 1800,
  });

  assert.equal(result, null);
  assert.match(logs[0].rejectedReasons[0], /PHP_GATE_ROUTE_END hotspot end/);
});

test('rejects a non-last hotspot whose projected destination arrival misses the deadline', async () => {
  const { result, logs } = await project({
    calculateProjectedArrivalToRouteDestination: async () => ({
      projectedArrivalSeconds: 19 * 3600,
      travelToDestSeconds: 3600,
    }),
  });

  assert.equal(result, null);
  assert.match(logs[0].rejectedReasons[0], /PHP_GATE_ROUTE_END projected arrival/);
});
