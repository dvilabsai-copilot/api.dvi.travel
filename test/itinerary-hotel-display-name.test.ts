import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsService } from '../src/modules/itineraries/itinerary-details.service';

test('timeline hotel labels decode persisted HTML entities consistently', () => {
  const normalize = (ItineraryDetailsService.prototype as any)
    .normalizeConfirmedTravelLabelsFromSequence;
  const rows = [
    { type: 'checkin', hotelName: 'SPRISE MUNNAR RESORT &amp; SPA' },
    { type: 'travel', from: 'SPRISE MUNNAR RESORT &amp; SPA', to: 'Rose Garden' },
  ];

  const result = normalize.call({}, rows, 'SPRISE MUNNAR RESORT &amp; SPA');

  assert.equal(result[0].hotelName, 'SPRISE MUNNAR RESORT & SPA');
  assert.equal(result[1].from, 'SPRISE MUNNAR RESORT & SPA');
  assert.equal(result[1].text, 'Travelling from SPRISE MUNNAR RESORT & SPA to Rose Garden');
});
