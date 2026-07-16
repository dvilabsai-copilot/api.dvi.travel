import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsDropOffService } from '../src/modules/itineraries/services/itinerary-details-dropoff.service';

const makeContext = (endTimeText: string | null) => ({
  route: { itinerary_route_ID: 7 },
  plan: { departure_location: 'Airport' },
  previousStopName: 'Hotel',
  startTimeText: '17:00',
  endTimeText,
  travelDistance: '12.50 KM',
  travelDuration: '00:45:00',
  routeEndMins: 18 * 60,
  isConflict: false,
  conflictReason: null,
  quoteId: 1,
  routeHotspotId: 2,
  proofQuoteEnabled: false,
  timeToMinutes: (value: string | null | undefined) => {
    const [hours, minutes] = String(value ?? '0:0').split(':').map(Number);
    return hours * 60 + minutes;
  },
  getTravelTimeRangeWithDuration: (start: string | null, end: string | null) => `${start} - ${end}`,
  formatDuration: (value: any) => `duration:${value}`,
});

test('projects a terminal drop-off travel segment', () => {
  const result = new ItineraryDetailsDropOffService().build(makeContext('17:45'));

  assert.equal(result.shouldSuppress, false);
  assert.equal(result.toName, 'Airport');
  assert.deepEqual(result.segment, {
    type: 'travel',
    from: 'Hotel',
    to: 'Airport',
    timeRange: '17:00 - 17:45',
    distance: '12.50 KM',
    duration: 'duration:00:45:00',
    note: 'This may vary due to traffic conditions',
    isConflict: false,
    conflictReason: null,
  });
});

test('suppresses a drop-off that exceeds the route end time', () => {
  const result = new ItineraryDetailsDropOffService().build(makeContext('18:30'));
  assert.equal(result.shouldSuppress, true);
});
