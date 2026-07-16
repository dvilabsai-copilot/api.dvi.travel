import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryLowPriorityRemovalService } from '../src/modules/itineraries/services/itinerary-low-priority-removal.service';

test('low-priority removal preserves the invalid-input no-op contract', async () => {
  const service = new ItineraryLowPriorityRemovalService(null as any);

  const result = await service.resolveLowPriorityRemovalForMatrixOverflowInTx(null, {
    planId: 0,
    routeId: 0,
    selectedHotspotId: 0,
    selectedManualPriority: 4,
    currentTimeline: [],
    dayEndMinutes: 1200,
    overflowMinutes: 30,
  });

  assert.deepEqual(result, {
    resolved: false,
    algorithm: 'NONE',
    originalOverflowMinutes: 30,
    overflowMinutes: 30,
    finalOverflowMinutes: 30,
    finalTimeline: [],
    finalArrivalTime: null,
    removedHotspots: [],
    candidateHotspots: [],
    simulationAttempts: [],
    rejectedAttempts: [],
    message: 'Unable to evaluate low-priority removals for matrix overflow.',
  });
});
