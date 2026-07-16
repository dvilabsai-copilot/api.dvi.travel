import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryActivityTimingPolicyService } from '../src/modules/itineraries/services/itinerary-activity-timing-policy.service';

test('converts UTC times and adds minutes without changing the original date', () => {
  const service = new ItineraryActivityTimingPolicyService();
  const start = new Date('2026-07-16T08:15:00.000Z');
  const end = service.addMinutesToTime(start, 90);
  assert.equal(service.timeToMinutes(start), 495);
  assert.equal(service.formatTime(end), '09:45');
  assert.equal(start.toISOString(), '2026-07-16T08:15:00.000Z');
});

test('reports an activity slot conflict and accepts a fitting slot', () => {
  const service = new ItineraryActivityTimingPolicyService();
  const activity = { activity_title: 'Museum visit' };
  const slots = [{ start_time: new Date('2026-07-16T10:00:00.000Z'), end_time: new Date('2026-07-16T11:00:00.000Z') }];
  assert.equal(service.checkActivityTimingConflicts(activity, slots, new Date('2026-07-16T09:00:00Z'), new Date('2026-07-16T09:30:00Z')).length, 1);
  assert.deepEqual(service.checkActivityTimingConflicts(activity, slots, new Date('2026-07-16T10:15:00Z'), new Date('2026-07-16T10:45:00Z')), []);
});
