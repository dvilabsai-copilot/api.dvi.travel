import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineSlotPolicyService } from '../src/modules/itineraries/engines/helpers/timeline-slot-policy.service';

const policy = new TimelineSlotPolicyService();

test('classifies morning and evening slots and finds the next slot', () => {
  assert.equal(policy.getDayTimeSlot('11:59:59'), 'MORNING');
  assert.equal(policy.getDayTimeSlot('12:00:00'), 'EVENING');
  assert.equal(policy.getNextSlotStart('MORNING'), '12:00:00');
  assert.equal(policy.getNextSlotStart('EVENING'), null);
});

test('preserves wait-until-open rules for priority and hotspot type', () => {
  assert.equal(policy.shouldAllowWaitUntilOpenForCandidate(1, 'museum'), true);
  assert.equal(policy.shouldAllowWaitUntilOpenForCandidate(0, 'museum'), false);
  assert.equal(policy.shouldAllowWaitUntilOpenForCandidate(1, 'restaurant'), false);
});

test('builds a free-time row with the original duration and status defaults', () => {
  const row = policy.buildFreeTimeBreakRow({ planId: 7, routeId: 8, order: 9, startTime: '10:00:00', endTime: '11:30:00', userId: 3 });
  assert.equal(row.itinerary_plan_ID, 7);
  assert.equal(row.itinerary_route_ID, 8);
  assert.equal(row.hotspot_ID, 0);
  assert.equal(row.item_type, 3);
  assert.equal(row.allow_break_hours, 1);
  assert.equal(row.deleted, 0);
});
