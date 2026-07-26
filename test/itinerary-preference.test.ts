import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveItineraryPreference } from '../src/modules/itineraries/utils/itinerary-preference.util';

test('preserves explicit Vehicle Only preference when stale hotel rows remain', () => {
  assert.equal(
    resolveItineraryPreference({
      rawPreference: 2,
      hasRouteFamily: true,
      hasHotelRows: true,
      hasVehicleRows: true,
    }),
    2,
  );
});

test('preserves explicit Hotel Only preference when stale vehicle rows remain', () => {
  assert.equal(
    resolveItineraryPreference({
      rawPreference: 1,
      hasRouteFamily: true,
      hasHotelRows: true,
      hasVehicleRows: true,
    }),
    1,
  );
});

test('infers combined mode only for a missing route-family preference', () => {
  assert.equal(
    resolveItineraryPreference({
      rawPreference: 0,
      hasRouteFamily: true,
      hasHotelRows: true,
      hasVehicleRows: true,
    }),
    3,
  );
});
