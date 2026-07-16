import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitRemovalExplanationService } from '../src/modules/itineraries/services/itinerary-manual-fit-removal-explanation.service';

test('builds deterministic priority-removal summaries and display rows', () => {
  const service = new ItineraryManualFitRemovalExplanationService();

  assert.deepEqual(service.buildRemovedPrioritySummary([
    { hotspotId: 3, priority: 3 },
    { hotspotId: 1, priority: 1 },
  ]), {
    removedP4: 0,
    removedP3: 1,
    removedP2: 0,
    removedP1: 1,
    highestRemovedPriority: 1,
    removalOrder: [4, 3, 2, 1],
    requiresPriorityRemovalConfirmation: true,
    severity: 'danger',
    message: 'This manual insertion will remove existing priority hotspots. Removal order used: Non-manual / Priority 4 -> Priority 3 -> Priority 2 -> Priority 1.',
  });

  assert.deepEqual(service.buildManualFitChangesRequiredDisplay({
    removedHotspots: [{ id: 3, name: 'Museum', priority: 3, reason: 'Route overflow' }],
  }), {
    hasRemovals: true,
    title: 'Changes Required',
    removalOrderLabel: 'Removal order checked: Non-manual / Priority 4 -> Priority 3 -> Priority 2 -> Priority 1',
    removedItems: [{
      hotspotId: 3,
      routeHotspotId: null,
      name: 'Museum',
      workPriority: 3,
      workPriorityLabel: 'Priority 3',
      reason: 'Route overflow',
      removalReasonCode: null,
      fitFailureExplanation: null,
    }],
    noRemovalText: 'No hotspot removed',
  });
});

test('enriches removal candidates from attraction rows only', () => {
  const service = new ItineraryManualFitRemovalExplanationService();

  assert.deepEqual(service.enrichRemovedHotspotCandidateWithAttempt({
    candidate: { hotspotId: 9, name: 'Fort' },
    attemptedTimeline: [
      { type: 'travel', locationId: 9, timeRange: '09:00 AM - 09:15 AM' },
      { type: 'attraction', locationId: 9, timeRange: '09:15 AM - 10:00 AM', timings: '09:00 AM - 06:00 PM' },
    ],
    attemptedTimelineSource: 'FINAL_PROPOSED_TIMELINE',
  }), {
    hotspotId: 9,
    name: 'Fort',
    attemptedVisitTime: '09:15 AM - 10:00 AM',
    attemptedArrivalTime: '09:15 AM',
    attemptedEndTime: '10:00 AM',
    operatingHours: '09:00 AM - 06:00 PM',
    outsideOperatingMinutes: 0,
    attemptedVisitSource: 'ATTRACTION_ROW',
    attemptedTimelineSource: 'FINAL_PROPOSED_TIMELINE',
  });
});

test('explains route-end overflow with removal evidence', () => {
  const service = new ItineraryManualFitRemovalExplanationService();

  const result = service.buildRemovedHotspotExplanation({
    row: { id: 7, name: 'Palace' },
    priority: 3,
    removalStage: 'P3_FIRST',
    routeEndOverflowMinutes: 35,
    routeEndTime: '18:00',
    manualHotspotName: 'Museum',
  });

  assert.equal(result.id, 7);
  assert.equal(result.removalReasonCode, 'ROUTE_END_OVERFLOW');
  assert.match(result.reason, /Palace.*35 minutes.*Museum/);
});
