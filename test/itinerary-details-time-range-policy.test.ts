import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsTimeRangePolicyService } from '../src/modules/itineraries/services/itinerary-details-time-range-policy.service';

test('parses display times and orders overnight ranges deterministically', () => {
  const policy = new ItineraryDetailsTimeRangePolicyService();
  assert.equal(policy.timeToMinutes('12:30 PM'), 750);
  assert.equal(policy.parseDisplayTimeMinutesStrict('bad'), null);
  assert.equal(policy.orderedTimeRange('10:00 PM', '02:00 AM'), '02:00 AM - 10:00 PM');
});

test('derives missing travel end times from stored durations', () => {
  const policy = new ItineraryDetailsTimeRangePolicyService();
  assert.equal(policy.getTravelTimeRangeWithDuration('10:00 AM', '10:00 AM', '02:30:00'), '10:00 AM - 12:30 PM');
  assert.equal(policy.formatDurationFromDisplayRange('10:00 PM', '12:30 AM'), '2 Hours 30 Min');
});

test('preserves null and non-positive duration fallbacks', () => {
  const policy = new ItineraryDetailsTimeRangePolicyService();
  assert.equal(policy.getTravelTimeRangeWithDuration(null, '11:00 AM', '01:00:00'), null);
  assert.equal(policy.formatDurationFromDisplayRange('10:00 AM', '10:00 AM'), null);
});
