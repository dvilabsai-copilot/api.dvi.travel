import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryRouteLegCacheService } from '../src/modules/itineraries/services/itinerary-route-leg-cache.service';

test('route-leg runtime cache preserves direct and reverse geometry lookups', () => {
  const service = new ItineraryRouteLegCacheService(null as any);
  service.setOsrmLegRuntimeCache(10, 20, {
    distanceKm: 12.5,
    durationMin: 30,
    coordinates: [[77.1, 10.1], [77.2, 10.2]],
  });

  assert.deepEqual(service.getOsrmLegFromRuntimeCache(10, 20, false), {
    distanceKm: 12.5,
    durationMin: 30,
    coordinates: [[77.1, 10.1], [77.2, 10.2]],
    usedReverse: false,
  });
  assert.deepEqual(service.getOsrmLegFromRuntimeCache(20, 10, true), {
    distanceKm: 12.5,
    durationMin: 30,
    coordinates: [[77.2, 10.2], [77.1, 10.1]],
    usedReverse: true,
  });
});

test('route-leg distance helpers retain conservative fallback rules', () => {
  const service = new ItineraryRouteLegCacheService(null as any);

  assert.equal(service.estimateDurationFromDistance(25), 60);
  assert.equal(service.estimateDurationFromDistance(null), null);
  assert.equal(service.chooseReliableTravelDistanceKm(0.1, 9), 9);
  assert.equal(service.chooseReliableTravelDistanceKm(null, null), null);
});
