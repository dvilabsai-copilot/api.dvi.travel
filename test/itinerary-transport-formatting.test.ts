import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryTransportFormattingService } from '../src/modules/itineraries/services/itinerary-transport-formatting.service';

test('preserves passenger labels and date-range fallback behavior', () => {
  const service = new ItineraryTransportFormattingService();
  assert.equal(service.buildPassengerMixLabel(2, 1, 0), '2 Adults, 1 Child');
  assert.equal(service.buildTransportDateRange(null, '2026-07-16'), service.formatTransportVoucherDate('2026-07-16'));
});

test('parses JSON flight details and decodes raw transport text', () => {
  const service = new ItineraryTransportFormattingService();
  const result = service.parseTransportFlightDetails('{"airline":"DVI Air","flightNo":"DV1","from":"COK","to":"DEL"}');
  assert.equal(result.airline, 'DVI Air');
  assert.equal(result.flightNo, 'DV1');
  assert.equal(service.decodeTransportHtml('Cochin &amp; Kochi'), 'Cochin & Kochi');
});
