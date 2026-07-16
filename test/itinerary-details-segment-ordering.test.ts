import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsSegmentOrderingService } from '../src/modules/itineraries/services/itinerary-details-segment-ordering.service';

test('sorts segments by start/end time and reinserts CTA after its travel anchor', () => {
  const service = new ItineraryDetailsSegmentOrderingService();
  const travel = { type: 'travel', from: 'City', to: 'Museum', timeRange: '10:00 AM - 10:30 AM' };
  const result = service.order([
    { type: 'attraction', name: 'Museum', visitTime: '10:30 AM - 12:00 PM' },
    { type: 'hotspot', anchorType: 'after_travel', text: 'Add', anchorFrom: 'City', anchorTo: 'Museum' },
    travel,
  ], {
    parseDisplayTimeMinutesStrict: (value) => {
      const [clock, period] = String(value).split(' ');
      const [h, m] = clock.split(':').map(Number);
      let hours = h % 12;
      if (period === 'PM') hours += 12;
      return hours * 60 + m;
    },
    normalizeName: (value) => String(value ?? '').trim().toLowerCase(),
  });

  assert.equal(result[0], travel);
  assert.equal(result[1].type, 'attraction');
  assert.equal(result[2].type, 'hotspot');
});
