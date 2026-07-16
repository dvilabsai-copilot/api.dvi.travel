import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryMatrixRescheduledPreviewService } from '../src/modules/itineraries/services/itinerary-matrix-rescheduled-preview.service';

test('matrix-rescheduled preview preserves an empty no-op timeline', async () => {
  const service = new ItineraryMatrixRescheduledPreviewService();
  let finalized = false;

  service.setCallbacks({
    buildMatrixMergedPreviewTimeline: () => [],
    finalizeMatrixPreviewTimeline: (timeline: any[]) => {
      finalized = true;
      return timeline;
    },
  });

  const result = await service.buildMatrixRescheduledPreviewTimeline({
    baselineTimeline: [],
    enginePreviewTimeline: [],
    manualInsertionFit: null,
    selectedHotspotId: 42,
    hotspotMasters: [],
  });

  assert.equal(finalized, true);
  assert.deepEqual(result, []);
});

test('matrix preview merge preserves the engine timeline when no fit is available', () => {
  const service = new ItineraryMatrixRescheduledPreviewService();
  const engineTimeline = [{ type: 'attraction', locationId: 9 }];

  const result = service.buildMatrixMergedPreviewTimeline({
    baselineTimeline: [{ type: 'attraction', locationId: 1 }],
    enginePreviewTimeline: engineTimeline,
    manualInsertionFit: null,
    selectedHotspotId: 42,
    hotspotMasters: [],
  });

  assert.deepEqual(result, engineTimeline);
});
