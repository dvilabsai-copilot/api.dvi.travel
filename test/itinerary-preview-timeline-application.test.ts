import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryPreviewTimelineApplicationService } from '../src/modules/itineraries/services/itinerary-preview-timeline-application.service';

test('preview timeline application preserves the invalid-fit no-op contract', () => {
  const timeline = [{ type: 'attraction', locationId: 10 }];
  const result = new ItineraryPreviewTimelineApplicationService(null as any)
    .applyManualInsertionFitToPreviewTimeline(timeline, null, 10);

  assert.equal(result, timeline);
});
