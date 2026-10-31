import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveIntercityDisplayDistanceKm } from '../src/modules/itineraries/utils/itinerary-distance.util';

test('direct non-sightseeing days use the visible travel distance', () => {
  assert.equal(
    resolveIntercityDisplayDistanceKm({
      viaRouteDistanceKm: 0,
      storedIntercityDistanceKm: 177.17,
      travelSegmentDistanceKm: 229.98,
      sightseeingDistanceKm: 0,
      hasHotspotSegments: false,
    }),
    229.98,
  );
});

test('hotspot days preserve the existing stored-route precedence', () => {
  assert.equal(
    resolveIntercityDisplayDistanceKm({
      viaRouteDistanceKm: 0,
      storedIntercityDistanceKm: 177.17,
      travelSegmentDistanceKm: 229.98,
      sightseeingDistanceKm: 52.81,
      hasHotspotSegments: true,
    }),
    177.17,
  );
});

test('via-route distance remains authoritative when available', () => {
  assert.equal(
    resolveIntercityDisplayDistanceKm({
      viaRouteDistanceKm: 180,
      storedIntercityDistanceKm: 177.17,
      travelSegmentDistanceKm: 229.98,
      sightseeingDistanceKm: 0,
      hasHotspotSegments: true,
    }),
    180,
  );
});

test('stored distance remains the fallback when no travel rows exist', () => {
  assert.equal(
    resolveIntercityDisplayDistanceKm({
      viaRouteDistanceKm: 0,
      storedIntercityDistanceKm: 177.17,
      travelSegmentDistanceKm: 0,
      sightseeingDistanceKm: 0,
      hasHotspotSegments: false,
    }),
    177.17,
  );
});
