import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineAnchorPolicyService } from '../src/modules/itineraries/engines/helpers/timeline-anchor-policy.service';

const policy = new TimelineAnchorPolicyService();

test('normalizes lookup keys and absolute route times', () => {
  assert.equal(policy.normalizePlaceLookupKey('Chennai International Airport, India'), 'chennai');
  assert.equal(policy.toAbsoluteSecondsForRoute('01:00:00', 23 * 3600), 25 * 3600);
  assert.equal(policy.getTravelLocationType('Mysuru|Coorg', 'Coorg'), 1);
});

test('builds ordered timeline anchors and real gaps', () => {
  const anchors = policy.buildFixedTimelineAnchors([
    { itinerary_route_ID: 4, item_type: 4, hotspot_ID: 12, hotspot_start_time: '10:00:00', hotspot_end_time: '11:00:00' } as any,
  ], 4, 9 * 3600, 18 * 3600, '09:00:00');
  assert.deepEqual(anchors.map((anchor) => anchor.kind), ['route_start', 'hotspot', 'route_end']);
  assert.deepEqual(policy.buildRealGapIntervals(anchors), [
    { start: 9 * 3600, end: 10 * 3600, durationSeconds: 3600 },
    { start: 11 * 3600, end: 18 * 3600, durationSeconds: 7 * 3600 },
  ]);
});

test('parses plan timestamps and tracks same-city continuation hotspots', () => {
  assert.equal(policy.extractPlanTimeOfDaySeconds('2026-07-16T14:30:15Z'), 14 * 3600 + 30 * 60 + 15);
  assert.equal(policy.toStoredTimeString(new Date('2026-07-16T05:06:07Z')), '05:06:07');
  const result = policy.buildSameCityContinuationContext(
    { itinerary_route_ID: 2, location_name: 'Mysuru', next_visiting_location: 'Mysuru' },
    { itinerary_route_ID: 1, location_name: 'Bengaluru', next_visiting_location: 'Mysuru' },
    [{ itinerary_route_ID: 1, item_type: 4, hotspot_ID: 55 } as any],
  );
  assert.equal(result.isSameCityChainContinuation, true);
  assert.deepEqual([...result.previousDayHotspotIds], [55]);
});
