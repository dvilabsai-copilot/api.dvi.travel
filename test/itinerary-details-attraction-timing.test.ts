import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsAttractionTimingService } from '../src/modules/itineraries/services/itinerary-details-attraction-timing.service';

const toMinutes = (value: string | null | undefined) => {
  const [hours, minutes] = String(value ?? '0:0').split(':').map(Number);
  return hours * 60 + minutes;
};

const orderedRange = (start: string | null, end: string | null) => start && end ? `${start} - ${end}` : null;

test('marks a visit outside the opening window and preserves operating-hours text', () => {
  const result = new ItineraryDetailsAttractionTimingService().build({
    routeDate: new Date('2026-07-13T00:00:00Z'),
    hotspotId: 9,
    startTimeText: '08:00',
    endTimeText: '09:00',
    timings: [{ hotspot_timing_day: 0, hotspot_closed: 0, hotspot_open_all_time: 0, hotspot_start_time: '10:00', hotspot_end_time: '18:00' }],
    orderedTimeRange: orderedRange,
    timeToMinutes: toMinutes,
    formatTime: String,
  });

  assert.equal(result.timingValidationExecuted, true);
  assert.equal(result.timingValidationPassed, false);
  assert.equal(result.visitTimeDisplay, '08:00 - 09:00 (opens at 10:00)');
  assert.equal(result.operatingHours, '10:00 - 18:00');
});

test('reports a closed day and open-all-day timing without changing the range contract', () => {
  const service = new ItineraryDetailsAttractionTimingService();
  const closed = service.build({
    routeDate: new Date('2026-07-13T00:00:00Z'),
    hotspotId: 9,
    startTimeText: '10:00',
    endTimeText: '11:00',
    timings: [{ hotspot_timing_day: 0, hotspot_closed: 1, hotspot_open_all_time: 0 }],
    orderedTimeRange: orderedRange,
    timeToMinutes: toMinutes,
    formatTime: String,
  });
  const allDay = service.build({
    routeDate: new Date('2026-07-13T00:00:00Z'),
    hotspotId: 9,
    startTimeText: '10:00',
    endTimeText: '11:00',
    timings: [{ hotspot_timing_day: 0, hotspot_closed: 0, hotspot_open_all_time: 1 }],
    orderedTimeRange: orderedRange,
    timeToMinutes: toMinutes,
    formatTime: String,
  });

  assert.equal(closed.visitTimeDisplay, '10:00 - 11:00 (closed on this day)');
  assert.equal(closed.operatingHours, 'Closed');
  assert.equal(allDay.visitTimeDisplay, '10:00 - 11:00');
  assert.equal(allDay.timingValidationPassed, true);
  assert.equal(allDay.operatingHours, 'Open 24 Hours');
});
