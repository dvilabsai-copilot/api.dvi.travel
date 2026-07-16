import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineArrivalHotelDecisionService } from '../src/modules/itineraries/engines/helpers/timeline-arrival-hotel-decision.service';

function createService(logs: any[]) {
  const service = new TimelineArrivalHotelDecisionService({
    calculateHaversine: () => 5,
  } as any);
  service.setCallbacks({
    getHotelDetailsForRoute: async () => ({ hotelId: 4, hotelName: 'Stay', hotelCity: 'Chennai', coords: { lat: 13, lon: 80 } }),
    canonicalCityKey: (value: string) => String(value || '').trim().toLowerCase(),
    toDateOnly: (value: Date) => new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())),
    getArrivalPolicyDecisionStateForRoute: async () => ({
      previousDayBillingDecisionProvided: false,
      previousDayBillingConfirmed: false,
    }),
    extractPlanTimeOfDaySeconds: (value: unknown) => {
      if (!(value instanceof Date)) return null;
      return value.getUTCHours() * 3600 + value.getUTCMinutes() * 60 + value.getUTCSeconds();
    },
    logBookingRule: (payload) => logs.push(payload),
    logTimeline: (name, payload) => logs.push({ name, payload }),
    getCurrentQuoteId: () => 'quote-1',
  });
  return service;
}

test('preserves late-arrival suppression and same-city hotel distance decisions', async () => {
  const logs: any[] = [];
  const service = createService(logs);
  const route = {
    itinerary_route_ID: 11,
    itinerary_route_date: new Date('2026-07-16T00:00:00Z'),
    is_full_day_trip: 0,
  };
  const plan = {
    trip_start_date_and_time: new Date('2026-07-16T18:00:00Z'),
    trip_start_date: new Date('2026-07-16T00:00:00Z'),
    trip_end_date: new Date('2026-07-20T00:00:00Z'),
    departure_type: 0,
  };

  const result = await service.evaluate({
    tx: {} as any,
    planId: 7,
    route,
    plan,
    isFirstRoute: true,
    isLastRoute: false,
    sourceCity: 'Chennai',
    destinationCity: 'Chennai',
    arrivalPoint: 'Chennai',
    currentCoords: { lat: 13, lon: 80 },
    destCityCoords: { lat: 13, lon: 80 },
    routeStartTime: '09:00:00',
    routeEndTime: '18:00:00',
    effectiveRouteStartTime: '09:00:00',
    currentTime: '09:00:00',
    routeStartSeconds: 32400,
    routeEndSeconds: 64800,
    lastRouteArrivalDeadlineSeconds: 64800,
    computeRouteEndSeconds: (startSeconds) => startSeconds + 9 * 3600,
  });

  assert.equal(result.isArrivalCityStayRoute, true);
  assert.equal(result.hotelDistanceFromArrivalKm, 5);
  assert.equal(result.shouldHotelFirstByDistance, true);
  assert.equal(result.forceNoSightseeingOnThisRoute, true);
  assert.equal(result.isTransferOnlyLastRouteByReportDeadline, false);
  assert.ok(logs.some((entry) => entry.name === '[TIMELINE] LATE_ARRIVAL_SKIP_SIGHTSEEING'));
});

test('preserves route clock and report-deadline behavior for a last route', async () => {
  const logs: any[] = [];
  const service = createService(logs);
  const result = await service.evaluate({
    tx: {} as any,
    planId: 7,
    route: { itinerary_route_ID: 12, itinerary_route_date: new Date('2026-07-19T00:00:00Z') },
    plan: {
      trip_start_date_and_time: null,
      trip_start_date: new Date('2026-07-16T00:00:00Z'),
      trip_end_date: new Date('2026-07-20T00:00:00Z'),
      trip_end_date_and_time: new Date('2026-07-20T10:00:00Z'),
      departure_type: 1,
    },
    isFirstRoute: false,
    isLastRoute: true,
    sourceCity: 'Chennai',
    destinationCity: 'Bengaluru',
    arrivalPoint: 'Chennai',
    routeStartTime: '08:00:00',
    routeEndTime: '12:00:00',
    effectiveRouteStartTime: '08:00:00',
    currentTime: '08:00:00',
    routeStartSeconds: 28800,
    routeEndSeconds: 43200,
    lastRouteArrivalDeadlineSeconds: 43200,
    computeRouteEndSeconds: (startSeconds) => startSeconds + 4 * 3600,
  });

  assert.equal(result.isTransferOnlyLastRouteByReportDeadline, true);
  assert.equal(result.forceNoSightseeingOnThisRoute, true);
  assert.equal(result.lastRouteArrivalDeadlineSeconds, 43200);
  assert.ok(logs.some((entry) => entry.name === '[TIMELINE] LAST_ROUTE_REPORT_CUTOFF_SKIP_SIGHTSEEING'));
});
