import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitCandidateSearchService } from '../src/modules/itineraries/services/itinerary-manual-fit-candidate-search.service';

test('selects the best insertion candidate and rebuilds the selected position', async () => {
  const service = new ItineraryManualFitCandidateSearchService();
  let rebuildCount = 0;
  service.setCallbacks({
    findRouteDetails: async () => ({ itinerary_route_ID: 2 }),
    buildRouteHotspotInsertionCandidates: async () => ({ hotspotRows: [{ hotspotId: 10, hotspotOrder: 1 }], masterMap: new Map() }),
    buildManualInsertionPositions: () => [{ candidateIndex: 0, anchorOrder: 1, positionLabel: 'start' }],
    buildPreferredManualInsertionIndex: () => null,
    simulateManualInsertionAtPosition: async () => ({ success: true, candidateIndex: 0, fullTimeline: [], score: 2 }),
    buildManualSlotInsights: () => [{ candidateIndex: 0, isBest: true }],
    chooseBestManualInsertionCandidate: (candidates: any[]) => candidates[0],
    rebuildManualHotspotSet: async () => { rebuildCount += 1; },
  });

  const result = await service.findBestManualInsertionCandidate({}, 1, 2, [99], { previewOnly: true });
  assert.equal(result.success, true);
  assert.deepEqual(result.slotInsights, [{ candidateIndex: 0, isBest: true }]);
  assert.equal(rebuildCount, 1);
});

test('runs cluster strategies and preserves the selected strategy log', async () => {
  const service = new ItineraryManualFitCandidateSearchService();
  service.setCallbacks({
    buildManualClusterCandidateOrders: () => [
      { strategyKey: 'first', strategyLabel: 'First', hotspotOrder: [99] },
      { strategyKey: 'second', strategyLabel: 'Second', hotspotOrder: [99] },
    ],
    findRouteDetails: async () => ({}),
    buildRouteHotspotInsertionCandidates: async () => ({ hotspotRows: [], masterMap: new Map() }),
    buildManualInsertionPositions: () => [],
    buildPreferredManualInsertionIndex: () => null,
    chooseBestManualInsertionCandidate: () => ({ success: false, candidateIndex: -1 }),
    simulateManualClusterOrder: async ({ strategy }: any) => ({ strategyKey: strategy.strategyKey, strategyLabel: strategy.strategyLabel, summary: strategy.strategyLabel, readyToApply: strategy.strategyKey === 'second' }),
    compareManualScheduleAttempts: (a: any, b: any) => Number(b.readyToApply) - Number(a.readyToApply),
  });

  const result = await service.runManualClusterOptimizer({}, 1, 2, [99], { hotspotRows: [], masterMap: new Map() });
  assert.equal(result.optimizerLog.selectedStrategyKey, 'second');
  assert.equal(result.optimizerLog.attempts.length, 2);
});
