import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualHotspotPreviewService } from '../src/modules/itineraries/services/itinerary-manual-hotspot-preview.service';

function createService() {
  return new ItineraryManualHotspotPreviewService(null as any);
}

test('manual hotspot preview preserves anchor label formatting', () => {
  assert.equal(
    createService().buildManualFitAnchorLabel({ anchorFrom: 'A', anchorTo: 'B', anchorTimeRange: '10:00 - 11:00' }),
    'A -> B (10:00 - 11:00)',
  );
});

test('manual hotspot preview preserves timeline fingerprint stability', () => {
  const service = createService();
  const first = service.buildManualFitTimelineFingerprint([{ type: 'HOTSPOT', text: 'A', timeRange: '10:00' }]);
  const second = service.buildManualFitTimelineFingerprint([{ type: 'HOTSPOT', text: 'A', timeRange: '10:00' }]);

  assert.equal(first, second);
});
