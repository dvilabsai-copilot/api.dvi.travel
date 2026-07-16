import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryAdaptiveManualHotspotInsertionService } from '../src/modules/itineraries/services/itinerary-adaptive-manual-hotspot-insertion.service';

test('adaptive manual hotspot insertion returns the successful optimizer result', async () => {
  const service = new ItineraryAdaptiveManualHotspotInsertionService();
  let normalizedIds: number[] = [];

  service.setCallbacks({
    normalizeManualHotspotIds: (ids: number[]) => {
      normalizedIds = ids;
      return [42];
    },
    buildRouteHotspotInsertionCandidates: async () => ({
      hotspotMasters: [{ hotspot_ID: 42, hotspot_name: 'Selected hotspot' }],
      classified: { strictTopPriority: [] },
    }),
    runManualClusterOptimizer: async (
      _tx: unknown,
      _planId: number,
      _routeId: number,
      selectedIds: number[],
    ) => ({
      bestCandidate: {
        success: true,
        requiresConfirmation: false,
        scheduledManualHotspots: selectedIds.map((id) => ({ id })),
        unscheduledManualHotspots: [],
        topPriorityAffected: [],
        slotInsights: [],
      },
      optimizerLog: { decisionOrder: ['baseline'], attempts: [] },
    }),
    buildDistanceAndToFroLabels: () => ({
      labels: { distance: '0 km', extraDetour: '0 km', toAndFro: '0 km' },
      values: { totalTravelKm: 0, extraTravelKm: 0, toAndFroPenalty: 0, candidateIndex: 0 },
    }),
  });

  const result = await service.runAdaptiveManualHotspotSetInsertion(
    null,
    7,
    8,
    [42, 42],
  );

  assert.deepEqual(normalizedIds, [42, 42]);
  assert.deepEqual(result.scheduledHotspotIds, [42]);
  assert.equal(result.requiresConfirmation, false);
  assert.equal(result.reason, null);
  assert.deepEqual(result.manualOptimizer?.decisionOrder, ['baseline']);
});
