import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsTimelinePresentationService } from '../src/modules/itineraries/services/itinerary-details-timeline-presentation.service';

test('preserves attraction time while repairing overlapping break chronology', () => {
  const service = new ItineraryDetailsTimelinePresentationService();
  const rows = [
    { type: 'travel', timeRange: '09:00 AM - 10:00 AM' },
    { type: 'attraction', visitTime: '09:30 AM - 10:30 AM' },
    { type: 'break', timeRange: '10:00 AM - 11:00 AM' },
  ];
  service.normalizeSegmentChronology(rows);
  assert.equal(rows[1].visitTime, '09:30 AM - 10:30 AM');
  assert.equal(rows[2].timeRange, '10:30 AM - 11:00 AM');
});

test('reconstructs travel labels from adjacent semantic stops', () => {
  const service = new ItineraryDetailsTimelinePresentationService();
  const rows = [
    { type: 'checkin', hotelName: 'Munnar Queen' },
    { type: 'travel', from: 'Munnar', to: 'Hotel' },
    { type: 'attraction', name: 'Tea Museum (Priority 1)' },
    { type: 'travel', from: 'Hotel', to: 'Hotel' },
    { type: 'checkin', hotelName: 'Hotel' },
  ];
  service.normalizeConfirmedTravelLabelsFromSequence(rows, 'Munnar Queen');
  assert.equal(rows[1].from, 'Munnar Queen');
  assert.equal(rows[1].to, 'Tea Museum');
  assert.equal(rows[3].from, 'Tea Museum');
  assert.equal(rows[3].to, 'Hotel');
});
