import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasItineraryRouteChanged,
  ItineraryPlanPersistenceService,
} from '../src/modules/itineraries/services/itinerary-plan-persistence.service';

function createService() {
  return new ItineraryPlanPersistenceService(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );
}

test('reusable template save preserves required plan validation', async () => {
  await assert.rejects(
    () => createService().saveReusableTemplate({ planId: 0 }, 1),
    /planId is required/,
  );
});

test('reusable template lookup preserves required location and day validation', async () => {
  await assert.rejects(
    () => createService().getReusableTemplateMatch('', 'Chennai', 0),
    /sourceLocation, destinationLocation, and dayCount are required/,
  );
});

test('route reset detection ignores regenerated route IDs when the stay shape is unchanged', () => {
  const previous = [{
    itinerary_route_ID: 10,
    itinerary_route_date: '2026-08-02T00:00:00.000Z',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
    no_of_km: 120,
    direct_to_next_visiting_place: 1,
    via_route: '',
  }];
  const next = [{
    itinerary_route_ID: 99,
    itinerary_route_date: '2026-08-02T00:00:00.000Z',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
    no_of_km: '120',
    direct_to_next_visiting_place: 1,
    via_route: '',
  }];

  assert.equal(hasItineraryRouteChanged(previous, next), false);
});

test('route reset detection fires when a destination or stay date changes', () => {
  const previous = [{
    itinerary_route_ID: 10,
    itinerary_route_date: '2026-08-02',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
  }];
  const next = [{
    itinerary_route_ID: 99,
    itinerary_route_date: '2026-08-03',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Alleppey',
  }];

  assert.equal(hasItineraryRouteChanged(previous, next), true);
});

test('route reset detection includes plan-level trip date and night changes', () => {
  const routes = [{
    itinerary_route_date: '2026-08-02',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
    no_of_km: 120,
    direct_to_next_visiting_place: 1,
  }];
  const plan = {
    trip_start_date: '2026-08-02T12:00:00+05:30',
    trip_end_date: '2026-08-04T12:00:00+05:30',
    no_of_nights: 2,
    no_of_days: 3,
    arrival_point: 'Cochin Airport',
    departure_point: 'Cochin Airport',
  };

  assert.equal(hasItineraryRouteChanged(routes, routes, plan, { ...plan, no_of_nights: 3 }), true);
});

test('route reset detection fires when via-route stops change', () => {
  const previous = [{
    itinerary_route_date: '2026-08-02',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
    via_routes: [{ itinerary_via_location_ID: 11, itinerary_via_location_name: 'Adimali' }],
  }];
  const next = [{
    itinerary_route_date: '2026-08-02',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
    via_routes: [{ itinerary_via_location_ID: 12, itinerary_via_location_name: 'Neriamangalam' }],
  }];

  assert.equal(hasItineraryRouteChanged(previous, next), true);
});
