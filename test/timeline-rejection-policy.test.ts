import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineRejectionPolicyService } from '../src/modules/itineraries/engines/helpers/timeline-rejection-policy.service';

const policy = new TimelineRejectionPolicyService();

test('classifies rejection reasons and gate breakdowns consistently', () => {
  assert.equal(policy.classifyRejectionReason('outside operating hours'), 'operatingHours');
  assert.equal(policy.classifyRejectionReason('duplicate_plan_scope'), 'duplicate');
  assert.deepEqual(policy.buildRejectionGateBreakdown(['outside operating hours', 'route end']), {
    alreadyUsedOnAnotherRoute: false,
    outsideOperatingHours: true,
    routeEndDeadline: true,
    duplicateSuppression: false,
    noRemainingWindow: false,
    other: false,
  });
});

test('records selected and rejected candidate counts by route', () => {
  policy.clear();
  policy.recordHotspotCandidateEvaluation({ routeId: 4, selected: true, rejectedReasons: [] });
  policy.recordHotspotCandidateEvaluation({ routeId: 4, selected: false, rejectedReasons: ['duplicate', 'route end'] });
  assert.deepEqual(policy.getSummaryByRoute()[4], {
    totalRejectedCandidates: 1,
    totalSelectedCandidates: 1,
    routeEnd: 1,
    operatingHours: 0,
    duplicate: 1,
    noRemainingWindow: 0,
    other: 0,
  });
});

test('does not apply a route-end buffer when the configured buffer is absent', () => {
  assert.equal(policy.getRouteEndBufferSeconds(4), 0);
});
