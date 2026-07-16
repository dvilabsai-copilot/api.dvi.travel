import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitRoutePolicyService } from '../src/modules/itineraries/services/itinerary-manual-fit-route-policy.service';

test('preserves route-fit labels and distance comparison metadata', () => {
  const service = new ItineraryManualFitRoutePolicyService();

  assert.deepEqual(service.buildRouteFitDisplayMeta({
    routeFitType: 'MINOR_DETOUR',
    roadDetourKm: 0.2,
    insertedRouteDistanceKm: 9,
    abOsrmDistanceKm: 10,
  }), {
    displayLabel: 'Near route / no extra distance',
    shortLabel: 'No extra distance',
    isZeroExtraDetour: true,
    distanceComparisonNote: 'Via route is equivalent or slightly shorter based on cached road distance.',
    finalDecisionReason: 'This hotspot is near the route and does not add meaningful extra travel distance.',
  });
});

test('classifies source and destination city contexts using normalized route fields', () => {
  const service = new ItineraryManualFitRoutePolicyService();

  assert.equal(service.classifyManualHotspotCityContext(
    { location_name: 'Kochi Airport', next_visiting_location: 'Munnar' },
    { hotspot_name: 'Tea Museum', hotspot_location: 'Munnar' },
  ), 'DESTINATION_CITY');
  assert.equal(service.classifyManualRouteAttractionCityContext(
    { location_name: 'Kochi', next_visiting_location: 'Munnar' },
    { hotspot_name: 'Fort Kochi', hotspot_location: 'Kochi' },
  ), 'SOURCE_CITY');
});

test('accepts valid manual matrix slots and preserves empty-route scheduler rules', () => {
  const service = new ItineraryManualFitRoutePolicyService();

  assert.equal(service.hasValidManualMatrixSlot({
    routeFitAvailable: true,
    chosenSlot: { routeFitType: 'ON_ROUTE', fromHotspotId: 10, toHotspotId: 20 },
  }), true);
  assert.equal(service.isEmptyRouteSchedulerEligible({
    chosenSlotSource: 'EMPTY_ROUTE_SCHEDULER',
    emptyRouteCityEndpointMode: true,
    selectedIncluded: true,
    canApply: true,
  }), true);
});
