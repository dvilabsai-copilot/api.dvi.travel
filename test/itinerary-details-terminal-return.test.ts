import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsTerminalReturnService } from '../src/modules/itineraries/services/itinerary-details-terminal-return.service';

const baseContext = {
  emittedTerminalSegment: false,
  previousStopName: 'Hotel',
  route: { route_start_time: '08:00', route_end_time: '18:00', next_visiting_location: 'Airport', no_of_km: '20' },
  plan: { departure_location: 'Airport' },
  formatTime: String,
  formatTravelDistance: (value: number | null) => `${value ?? 0} KM`,
  formatDuration: (value: any) => `duration:${value}`,
  formatDurationFromDisplayRange: (start: string, end: string) => `${start} to ${end}`,
};

test('builds an airport transfer when no terminal row exists', () => {
  const result = new ItineraryDetailsTerminalReturnService().build(baseContext);
  assert.deepEqual(result, {
    type: 'travel',
    from: 'Hotel',
    to: 'Airport',
    timeRange: '08:00 -> 18:00',
    distance: '20 KM',
    duration: '08:00 to 18:00',
    note: 'Airport transfer',
    isConflict: false,
    conflictReason: null,
  });
});

test('builds a return segment for a non-terminal destination', () => {
  const result = new ItineraryDetailsTerminalReturnService().build({
    ...baseContext,
    route: { ...baseContext.route, next_visiting_location: 'Hotel' },
  });
  assert.deepEqual(result, { type: 'return', time: '18:00', note: null });
});

test('does not add a fallback after an explicit terminal segment', () => {
  const result = new ItineraryDetailsTerminalReturnService().build({ ...baseContext, emittedTerminalSegment: true });
  assert.equal(result, null);
});
