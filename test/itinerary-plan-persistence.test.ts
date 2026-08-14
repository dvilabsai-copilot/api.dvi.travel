import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getHotelAvailabilityResetReason,
  hasItineraryMealPlanChanged,
  hasItineraryRoomCountChanged,
  hasItineraryRouteChanged,
  ItineraryPlanPersistenceService,
  resolveItineraryMealPlanCode,
  resolveItineraryRoomCount,
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

test('route reset detection ignores derived distance changes', () => {
  const previous = [{
    itinerary_route_date: '2026-08-02',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
    no_of_km: 109.5,
  }];
  const next = [{
    itinerary_route_date: '2026-08-02',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
    no_of_km: 112.75,
  }];

  assert.equal(hasItineraryRouteChanged(previous, next), false);
});

test('route reset detection preserves the calendar day across timezone formats', () => {
  const previous = [{
    itinerary_route_date: '2026-08-19T00:00:00.000Z',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
  }];
  const next = [{
    itinerary_route_date: '2026-08-19T00:00:00+05:30',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
  }];

  assert.equal(hasItineraryRouteChanged(previous, next), false);
});

test('route reset detection ignores non-route plan edits', () => {
  const routes = [{
    itinerary_route_date: '2026-08-02',
    location_name: 'Cochin Airport',
    next_visiting_location: 'Munnar',
    no_of_km: 109.5,
  }];
  const plan = {
    trip_start_date: '2026-08-02T12:00:00+05:30',
    trip_end_date: '2026-08-04T12:00:00+05:30',
    no_of_nights: 2,
    no_of_days: 3,
    arrival_point: 'Cochin Airport',
    departure_point: 'Cochin Airport',
    budget: 20000,
    guide_for_itinerary: 0,
    meal_plan_code: 'CP',
  };

  assert.equal(hasItineraryRouteChanged(
    routes,
    routes,
    plan,
    { ...plan, budget: 30000, guide_for_itinerary: 1, meal_plan_code: 'MAP' },
  ), false);
});

test('meal-plan reset detection fires for a canonical CP to MAP change', () => {
  assert.equal(hasItineraryMealPlanChanged(
    {
      meal_plan_code: 'CP',
      meal_plan_breakfast: 1,
      meal_plan_lunch: 0,
      meal_plan_dinner: 0,
    },
    {
      meal_plan_code: 'MAP',
      meal_plan_breakfast: 1,
      meal_plan_lunch: 0,
      meal_plan_dinner: 1,
    },
  ), true);
});

test('meal-plan reset detection does not fire when only legacy flags disagree with an explicit code', () => {
  const previous = {
    meal_plan_code: 'MAP',
    meal_plan_breakfast: 1,
    meal_plan_lunch: 1,
    meal_plan_dinner: 1,
  };
  const next = {
    meal_plan_code: 'Modified American Plan',
    meal_plan_breakfast: 1,
    meal_plan_lunch: 0,
    meal_plan_dinner: 1,
  };

  assert.equal(resolveItineraryMealPlanCode(previous), 'MAP');
  assert.equal(resolveItineraryMealPlanCode(next), 'MAP');
  assert.equal(hasItineraryMealPlanChanged(previous, next), false);
});

test('meal-plan reset detection falls back to legacy flags when the canonical code is absent', () => {
  assert.equal(hasItineraryMealPlanChanged(
    { meal_plan_breakfast: 1, meal_plan_lunch: 0, meal_plan_dinner: 0 },
    { meal_plan_breakfast: 0, meal_plan_lunch: 0, meal_plan_dinner: 0 },
  ), true);
  assert.equal(
    resolveItineraryMealPlanCode({ meal_plan_breakfast: 0, meal_plan_lunch: 0, meal_plan_dinner: 0 }),
    'EP',
  );
});

test('hotel reset reason triggers for meal-plan-only edits and preserves route precedence', () => {
  assert.equal(getHotelAvailabilityResetReason({ routeChanged: false, mealPlanChanged: true }), 'MEAL_PLAN_CHANGED');
  assert.equal(getHotelAvailabilityResetReason({ routeChanged: true, mealPlanChanged: true }), 'ROUTE_CHANGED');
  assert.equal(getHotelAvailabilityResetReason({ routeChanged: false, roomCountChanged: true }), 'ROOM_COUNT_CHANGED');
  assert.equal(getHotelAvailabilityResetReason({ routeChanged: true, roomCountChanged: true }), 'ROUTE_CHANGED');
  assert.equal(getHotelAvailabilityResetReason({ routeChanged: false, mealPlanChanged: false }), null);
});

test('room-count reset detection follows traveller room ids', () => {
  const twoRooms = [{ room_id: 1 }, { room_id: 2 }, { room_id: 1 }];
  const oneRoom = [{ room_id: 1 }, { room_id: 1 }];

  assert.equal(resolveItineraryRoomCount(twoRooms), 2);
  assert.equal(resolveItineraryRoomCount(oneRoom), 1);
  assert.equal(hasItineraryRoomCountChanged({ preferred_room_count: 2 }, oneRoom), true);
  assert.equal(hasItineraryRoomCountChanged({ preferred_room_count: 1 }, oneRoom), false);
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
