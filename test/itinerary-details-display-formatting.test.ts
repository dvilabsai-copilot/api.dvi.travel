import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsDisplayFormattingService } from '../src/modules/itineraries/services/itinerary-details-display-formatting.service';

test('formats database dates with UTC-safe date-only projection', () => {
  const formatting = new ItineraryDetailsDisplayFormattingService();
  assert.equal(formatting.formatDbDateOnly('2026-07-17 23:30:00'), '2026-07-17');
  assert.equal(formatting.formatDbDateOnly(new Date('2026-07-17T23:30:00.000Z')), '2026-07-17');
  assert.equal(formatting.formatDbDateOnly('invalid'), '');
});

test('preserves UTC clock and duration labels', () => {
  const formatting = new ItineraryDetailsDisplayFormattingService();
  assert.equal(formatting.formatTime(new Date('1970-01-01T12:05:00.000Z')), '12:05 PM');
  assert.equal(formatting.formatTripDateTime('2026-07-17T00:09:00.000Z'), '12:09 AM');
  assert.equal(formatting.formatDuration('02:30:00'), '2 Hours 30 Min');
  assert.equal(formatting.formatDuration('00:00:00'), null);
});

test('formats created-on dates using the existing locale shape', () => {
  const formatting = new ItineraryDetailsDisplayFormattingService();
  assert.match(formatting.formatCreatedOn(new Date('2026-07-17T00:00:00.000Z')), /Jul 17, 2026/);
  assert.equal(formatting.pad2(7), '07');
});
