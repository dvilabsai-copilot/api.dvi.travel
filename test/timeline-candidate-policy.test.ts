import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineCandidatePolicyService } from '../src/modules/itineraries/engines/helpers/timeline-candidate-policy.service';
import { TimelineOperatingHoursService } from '../src/modules/itineraries/engines/helpers/timeline-operating-hours.service';
import { TimelineRejectionPolicyService } from '../src/modules/itineraries/engines/helpers/timeline-rejection-policy.service';
import { TimelineRoutePolicyService } from '../src/modules/itineraries/engines/helpers/timeline-route-policy.service';
import { TimelineSlotPolicyService } from '../src/modules/itineraries/engines/helpers/timeline-slot-policy.service';

test('timeline candidate policy preserves bucket and carry-forward ordering', () => {
  const service = new TimelineCandidatePolicyService(
    new TimelineOperatingHoursService(),
    new TimelineSlotPolicyService(),
    new TimelineRejectionPolicyService(),
    new TimelineRoutePolicyService(),
  );

  const sorted = service.sortCarryForwardHotspots([
    { hotspot_ID: 4, hotspot_priority: 4, carryOrder: 1, carriedFromRouteId: 1, carriedFromDate: '2026-01-01' },
    { hotspot_ID: 1, hotspot_priority: 1, carryOrder: 2, carriedFromRouteId: 1, carriedFromDate: '2026-01-01' },
  ]);

  assert.equal(service.resolveTimelineBucket({ matched_bucket: ' Via ' }), 'via');
  assert.equal(service.isRouteMovementBucket('boundary'), true);
  assert.deepEqual(sorted.map((row) => row.hotspot_ID), [1, 4]);
  assert.deepEqual(service.buildRouteLegs('Chennai', ['Madurai'], 'Kochi'), ['Chennai', 'Madurai', 'Kochi']);
});
