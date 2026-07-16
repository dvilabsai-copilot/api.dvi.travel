import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsSegmentSanitizerService } from '../src/modules/itineraries/services/itinerary-details-segment-sanitizer.service';

test('removes excluded, named and no-op travel segments while preserving valid rows', () => {
  const service = new ItineraryDetailsSegmentSanitizerService();
  const result = service.sanitize({
    segments: [
      { type: 'attraction', hotspotId: 9, name: 'Hidden Fort' },
      { type: 'attraction', hotspotId: 10, name: 'Visible Museum' },
      { type: 'travel', from: 'Hotel', to: 'Hotel' },
      { type: 'travel', from: 'City', to: 'City' },
      { type: 'return', time: '06:00 PM' },
    ],
    excludedIds: new Set([9]),
    hotspotMap: new Map([[9, { hotspot_name: 'Hidden Fort' }]]),
    normalizePlaceLabel: (value) => String(value ?? '').trim().toLowerCase(),
    isGenericHotelLabel: (value) => String(value ?? '').trim().toLowerCase() === 'hotel',
    isSamePlaceLike: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
  });

  assert.deepEqual(result, [
    { type: 'attraction', hotspotId: 10, name: 'Visible Museum' },
    { type: 'return', time: '06:00 PM' },
  ]);
});
