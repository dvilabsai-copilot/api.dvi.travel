import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitScheduleAttemptService } from '../src/modules/itineraries/services/itinerary-manual-fit-schedule-attempt.service';

function createService(): ItineraryManualFitScheduleAttemptService {
  const service = new ItineraryManualFitScheduleAttemptService();
  service.setCallbacks({
    distanceBetweenHotspots: (_map: Map<number, any>, from: number, to: number) => Math.abs(Number(from || 0) - Number(to || 0)),
    calculateInsertionExtraDistance: () => 1.25,
    calculateToAndFroPenalty: () => 0.5,
    isAttractionTimelineRow: (row: any) => Number(row?.item_type || 0) === 4,
    getTimelineRowHotspotId: (row: any) => Number(row?.hotspot_ID || 0),
    manualFitTimelinePreservesSelectedAnchor: () => true,
    parsePreviewTimeToMinutes: (value: any) => {
      const [hour, minute] = String(value).split(':').map(Number);
      return Number.isFinite(hour) && Number.isFinite(minute) ? (hour * 60) + minute : null;
    },
    explainManualScheduleAttempt: (attempt: any) => attempt.readyToApply ? 'ready' : attempt.reason,
  });
  return service;
}

test('projects travel totals and protected priority impact', () => {
  const service = createService();
  assert.deepEqual(service.calculateTravelMetricsFromTimeline([
    { item_type: 4, hotspot_ID: 10 },
    { item_type: 4, hotspot_ID: 15 },
  ], new Set([15]), new Map()), {
    totalTravelKm: 5,
    extraTravelKm: 1.25,
    toAndFroPenalty: 0.5,
  });

  const impact = service.detectTopPriorityImpact(new Map([[10, { id: 10, name: 'Protected', priority: 1 }]]), {
    classified: { strictTopPriority: [], p3ConfirmationCandidates: [] },
  });
  assert.equal(impact[0].reason, 'Protected P1 hotspot would be removed or invalidated by this schedule attempt.');
});

test('preserves exact-anchor overlap and readiness decisions', () => {
  const service = createService();
  const attempt = service.buildExactAnchorSequentialScheduleAttempt({
    strategy: {
      strategyKey: 'exact_anchor_sequential_rebuild',
      strategyLabel: 'Selected Fit Here Sequence',
      description: 'Exact anchor',
      hotspotOrder: [99],
      exactAnchorIntent: 'AFTER_ATTRACTION',
    },
    candidate: {
      success: true,
      candidateIndex: 0,
      fullTimeline: [
        { item_type: 4, hotspot_ID: 99, timeRange: '09:00 - 10:00' },
        { item_type: 4, hotspot_ID: 10, timeRange: '10:00 - 11:00' },
      ],
      waitingMinutes: 0,
      extraTravelKm: 0,
      totalTravelKm: 0,
      scheduledManualHotspots: [{ id: 99 }],
      requiresConfirmation: false,
    },
  });
  assert.equal(attempt.success, true);
  assert.equal(attempt.readyToApply, true);
  assert.equal(attempt.summary, 'ready');
});

test('orders ready attempts before confirmation and unsafe attempts', () => {
  const service = createService();
  const ready: any = { readyToApply: true, removedOptionalCount: 0, removedTopPriorityCount: 0, requiresConfirmation: false, timingSafe: true, topPriorityAffectedCount: 0, routeEndOverflowMinutes: 0, openingHourConflictCount: 0, waitingMinutes: 0, extraTravelKm: 1, totalTravelKm: 1, candidateIndex: 0 };
  const confirmation: any = { ...ready, readyToApply: false, requiresConfirmation: true, candidateIndex: 1 };
  assert.equal(service.compareManualScheduleAttempts(ready, confirmation), -2);
});
