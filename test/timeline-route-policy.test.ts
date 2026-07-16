import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineRoutePolicyService } from '../src/modules/itineraries/engines/helpers/timeline-route-policy.service';

const policy = new TimelineRoutePolicyService();

test('normalizes city keys and collapses duplicate route legs', () => {
  assert.equal(policy.canonicalCityKey('Chennai International Airport'), 'chennai');
  assert.equal(policy.isSameCity('Bengaluru', 'Bengaluru Airport'), true);
  assert.deepEqual(policy.buildRouteLegs('Chennai', ['Pondicherry', 'Pondicherry'], 'Chennai'), ['Chennai', 'Pondicherry', 'Chennai']);
});

test('matches hotspot route chains and preserves movement ordering', () => {
  assert.deepEqual(policy.routeSpecificHotspotMatchesRouteChain('Chennai', 'Pondicherry', ['Chennai', 'Pondicherry', 'Bengaluru']), {
    matches: true,
    fromIndex: 0,
    toIndex: 1,
  });
  assert.equal(policy.routeMovementOrder(1, 2, 'en_route'), 120);
  assert.equal(policy.routeMovementOrder(1, 2, 'via_stop'), 190);
});

test('checks carry-forward endpoint compatibility and estimates route capacity', () => {
  assert.equal(policy.isCarryForwardHotspotCompatibleWithRoute(
    { hotspot_location: 'Mysuru', hotspot_to_location: 'Coorg' },
    { routeId: 1, routeDay: 2, sourceCity: 'Mysuru', destinationCity: 'Coorg' },
  ).compatible, true);
  assert.equal(policy.estimateRouteHotspotCapacity({ route_start_time: '09:00:00', route_end_time: '18:00:00' }), 4);
  assert.equal(policy.estimateRouteHotspotCapacity(null), 0);
});
