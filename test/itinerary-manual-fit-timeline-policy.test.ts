import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitTimelinePolicyService } from '../src/modules/itineraries/services/itinerary-manual-fit-timeline-policy.service';

test('sanitizes removed manual-fit rows and rebuilds preview ordering', () => {
  const service = new ItineraryManualFitTimelinePolicyService();

  assert.deepEqual(service.sanitizeResolvedLowPriorityTimeline([
    { type: 'attraction', locationId: 10, previewOrder: 9, matrixPreviewOrder: 9 },
    { type: 'attraction', locationId: 20, previewOrder: 10, matrixPreviewOrder: 10 },
    { type: 'attraction', locationId: 30, previewOrder: 11, matrixPreviewOrder: 11 },
  ], [{ id: 20, name: 'Removed' }]), [
    { type: 'attraction', locationId: 10, previewOrder: 0, matrixPreviewOrder: 0 },
    { type: 'attraction', locationId: 30, previewOrder: 1, matrixPreviewOrder: 1 },
  ]);
});

test('preserves low-priority timeline invariant diagnostics', () => {
  const service = new ItineraryManualFitTimelinePolicyService();
  service.setCallbacks({ parseSegmentEndMinutes: (row) => Number(row?.endMinutes ?? 0) });

  assert.equal(service.validateResolvedLowPriorityTimeline([
    { type: 'attraction', locationId: 20, matrixPreviewOrder: 0, endMinutes: 600 },
  ], [{ id: 20, name: 'Removed' }], 1_000), 'Resolved timeline still contains removed hotspot id 20.');
});

test('marks exact-anchor manual insertion metadata without changing unrelated fit fields', () => {
  const service = new ItineraryManualFitTimelinePolicyService();

  assert.deepEqual(service.normalizeExactAnchorManualInsertionFit({
    manualInsertionFit: { score: 7, requestedSlot: { label: 'old' } },
    anchorIntent: 'AFTER_ATTRACTION',
    afterHotspotId: 10,
    beforeHotspotId: 20,
    anchorLabel: 'Between stops',
  }), {
    score: 7,
    requestedSlot: {
      label: 'Between stops',
      fromHotspotId: 10,
      toHotspotId: 20,
      source: 'EXACT_ANCHOR',
      chosenSlotSource: 'EXACT_ANCHOR',
      selectedAsBest: true,
      attempted: true,
      exactAnchor: true,
      anchorIntent: 'AFTER_ATTRACTION',
      displayLabel: 'Between stops',
      shortLabel: 'Between stops',
    },
    chosenSlot: {
      label: 'Between stops',
      fromHotspotId: 10,
      toHotspotId: 20,
      source: 'EXACT_ANCHOR',
      chosenSlotSource: 'EXACT_ANCHOR',
      selectedAsBest: true,
      attempted: true,
      exactAnchor: true,
      anchorIntent: 'AFTER_ATTRACTION',
      displayLabel: 'Between stops',
      shortLabel: 'Between stops',
    },
    bestSlot: {
      label: 'Between stops',
      fromHotspotId: 10,
      toHotspotId: 20,
      source: 'EXACT_ANCHOR',
      chosenSlotSource: 'EXACT_ANCHOR',
      selectedAsBest: true,
      attempted: true,
      exactAnchor: true,
      anchorIntent: 'AFTER_ATTRACTION',
      displayLabel: 'Between stops',
      shortLabel: 'Between stops',
    },
    chosenSlotSource: 'EXACT_ANCHOR',
  });
});
