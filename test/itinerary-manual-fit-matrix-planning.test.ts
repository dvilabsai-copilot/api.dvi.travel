import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryManualFitMatrixPlanningService } from '../src/modules/itineraries/services/itinerary-manual-fit-matrix-planning.service';

function createService() {
  return new ItineraryManualFitMatrixPlanningService(null as any);
}

test('manual fit matrix planning rejects incomplete matrix input without database access', async () => {
  const result = await createService().resolveMatrixBestInsertionGap({
    routeId: 0,
    selectedHotspotId: 0,
    manualInsertionFit: null,
  });

  assert.deepEqual(result, {
    shouldUseMatrixSlot: false,
    fromHotspotId: 0,
    toHotspotId: 0,
    gapIndex: -1,
    reason: 'MISSING_MATRIX_FIT_OR_INPUT',
  });
});

test('manual fit matrix planning returns the ordered timeline when no removals are requested', async () => {
  const timeline = [
    { type: 'attraction', locationId: 11, timeRange: '10:00 AM - 11:00 AM' },
    { type: 'attraction', locationId: 10, timeRange: '08:00 AM - 09:00 AM' },
  ];

  const result = await createService().buildMatrixRouteTimelineAfterLowPriorityRemoval(
    null,
    timeline,
    [],
  );

  assert.deepEqual(result, timeline);
});
