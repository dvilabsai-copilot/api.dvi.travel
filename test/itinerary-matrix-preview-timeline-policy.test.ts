import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryMatrixPreviewTimelinePolicyService } from '../src/modules/itineraries/services/itinerary-matrix-preview-timeline-policy.service';

test('normalizes travel labels to the next attraction or hotel stop', () => {
  const service = new ItineraryMatrixPreviewTimelinePolicyService();

  assert.deepEqual(service.normalizeTravelLabelsToNextStop([
    { type: 'attraction', text: 'Museum' },
    { type: 'travel', item_type: 3, text: 'Old travel label' },
    { type: 'hotel', text: 'Check-in at Lakeside Hotel' },
  ]), [
    { type: 'attraction', text: 'Museum' },
    {
      type: 'travel',
      item_type: 5,
      text: 'Travel to Lakeside Hotel',
      name: 'Travel to Lakeside Hotel',
      fromName: 'Museum',
      toName: 'Lakeside Hotel',
      from: 'Museum',
      to: 'Lakeside Hotel',
      displayFromName: 'Museum',
      displayToName: 'Lakeside Hotel',
      isMatrixReconnectedTravel: true,
    },
    { type: 'hotel', text: 'Check-in at Lakeside Hotel' },
  ]);
});

test('repairs placeholder time ranges using duration fields and preserves ordering', () => {
  const service = new ItineraryMatrixPreviewTimelinePolicyService();
  service.setCallbacks({
    parseSegmentStartMinutes: (row) => row?.startMinutes ?? null,
    parseSegmentEndMinutes: (row) => row?.endMinutes ?? null,
    parsePreviewTimeToMinutes: () => null,
  });

  assert.deepEqual(service.finalizeMatrixPreviewTimeline([
    { type: 'travel', timeRange: 'Needs recalculation', duration: '30 minutes' },
    { type: 'attraction', timeRange: '10:30 AM - 11:30 AM' },
  ]), [
    {
      type: 'travel',
      timeRange: '12:00 AM - 12:30 AM',
      duration: '30 minutes',
      item_type: 3,
      text: 'Travel to Hotel',
      name: 'Travel to Hotel',
      fromName: 'Hotel / Route Start',
      toName: 'Hotel',
      from: 'Hotel / Route Start',
      to: 'Hotel',
      displayFromName: 'Hotel / Route Start',
      displayToName: 'Hotel',
      isMatrixReconnectedTravel: true,
      previewOrder: 0,
      matrixPreviewOrder: 0,
    },
    { type: 'attraction', timeRange: '10:30 AM - 11:30 AM', previewOrder: 1, matrixPreviewOrder: 1 },
  ]);
});

test('parses duration fields and formats preview labels with the legacy clock format', () => {
  const service = new ItineraryMatrixPreviewTimelinePolicyService();
  service.setCallbacks({ parsePreviewTimeToMinutes: (value) => {
    const match = String(value).match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!match) return null;
    let hour = Number(match[1]);
    if (match[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (match[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
    return hour * 60 + Number(match[2]);
  } });

  assert.equal(service.getPreviewRowDurationMinutes({ duration: '2 hours 15 minutes' }), 135);
  assert.equal(service.minutesRangeToFitPreviewLabel(23 * 60 + 30, 25 * 60 + 15), '11:30 PM - 1:15 AM +1d');
});
