import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitCandidateSimulationService } from '../src/modules/itineraries/services/itinerary-manual-fit-candidate-simulation.service';

test('simulates a scheduled manual candidate without changing result fields', async () => {
  const service = new ItineraryManualFitCandidateSimulationService();
  service.setCallbacks({
    rebuildManualHotspotSet: async () => undefined,
    buildRouteHotspotInsertionCandidates: async () => ({
      masterMap: new Map([[99, { hotspot_name: 'Manual Stop' }]]),
      hotspotRows: [{ hotspotId: 99 }],
    }),
    getManualHotspotScheduleState: async () => ({ scheduledHotspotIds: [99], unscheduledManualHotspots: [] }),
    getRouteTimelineForScoring: async () => [{ item_type: 4, hotspot_ID: 99 }],
    calculateWaitingMinutes: () => 4,
    calculateTravelMetricsFromTimeline: () => ({ totalTravelKm: 12.5, extraTravelKm: 1.5, toAndFroPenalty: 0.2 }),
    detectTopPriorityImpact: () => [],
    calculateRouteEndOverflowMinutes: () => 0,
    scoreManualInsertionCandidate: () => 8,
    getManualEffectivePriority: () => 4,
    explainRejectedCandidate: () => null,
  });

  const result = await service.simulateManualInsertionAtPosition(
    {},
    1,
    2,
    { id: 2 },
    [99],
    { candidateIndex: 0, anchorOrder: 1, positionLabel: 'start' },
    new Map(),
  );

  assert.deepEqual({
    success: result.success,
    candidateIndex: result.candidateIndex,
    score: result.score,
    waitingMinutes: result.waitingMinutes,
    totalTravelKm: result.totalTravelKm,
    extraTravelKm: result.extraTravelKm,
    scheduledManualHotspots: result.scheduledManualHotspots,
    reason: result.reason,
  }, {
    success: true,
    candidateIndex: 0,
    score: 8,
    waitingMinutes: 4,
    totalTravelKm: 12.5,
    extraTravelKm: 1.5,
    scheduledManualHotspots: [{ id: 99, name: 'Manual Stop', priorityLabel: 'Manual / P4' }],
    reason: null,
  });
});

test('retains exact-anchor failure reason when the rebuilt timeline loses the clicked gap', async () => {
  const service = new ItineraryManualFitCandidateSimulationService();
  service.setCallbacks({
    buildRouteHotspotInsertionCandidates: async () => ({ masterMap: new Map(), hotspotRows: [] }),
    getManualHotspotScheduleState: async () => ({ scheduledHotspotIds: [], unscheduledManualHotspots: [] }),
    getRouteTimelineForScoring: async () => [],
    manualFitTimelinePreservesSelectedAnchor: () => false,
    calculateTravelMetricsFromTimeline: () => ({ totalTravelKm: 0, extraTravelKm: 0, toAndFroPenalty: 0 }),
    detectTopPriorityImpact: () => [],
    calculateRouteEndOverflowMinutes: () => 0,
    scoreManualInsertionCandidate: () => 0,
    explainRejectedCandidate: () => 'fallback',
  });

  const result = await service.simulateManualInsertionAtPosition({}, 1, 2, {}, [99], { candidateIndex: 0, anchorOrder: 1, positionLabel: 'start' }, new Map(), new Map(), {
    exactAnchorMode: true,
    anchorIntent: 'AFTER_START',
  });
  assert.equal(result.success, false);
  assert.match(String(result.reason), /first attraction after route start/i);
});
