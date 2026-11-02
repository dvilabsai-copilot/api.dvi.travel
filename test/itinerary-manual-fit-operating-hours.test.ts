import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItineraryManualFitOperatingHoursService } from '../src/modules/itineraries/services/itinerary-manual-fit-operating-hours.service';

function createService(): ItineraryManualFitOperatingHoursService {
  const service = new ItineraryManualFitOperatingHoursService({} as any);
  service.setCallbacks({
    parsePreviewTimeToMinutes: (value: any) => {
      const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (!match) return null;
      let hour = Number(match[1]);
      if (match[3]?.toUpperCase() === 'AM' && hour === 12) hour = 0;
      if (match[3]?.toUpperCase() === 'PM' && hour !== 12) hour += 12;
      return hour * 60 + Number(match[2]);
    },
  });
  return service;
}

test('parses normal and overnight operating windows', () => {
  const service = createService();

  assert.equal(service.extractTimeWindowsFromLabel('09:00 AM - 06:00 PM')[0].startMinutes, 540);
  assert.equal(service.extractTimeWindowsFromLabel('10:00 PM - 02:00 AM')[0].endMinutes, 120);
  assert.deepEqual(service.extractTimeWindowsFromLabel('Open 24 hours'), []);
});

test('preserves operating-hours conflict reasons and open-day behavior', () => {
  const service = createService();

  const conflict = service.evaluateTimelineRowAgainstOperatingHours({
    timeRange: '07:00 AM - 08:00 AM',
    timings: '09:00 AM - 06:00 PM',
  });
  assert.equal(conflict.valid, false);
  assert.match(String(conflict.reason), /closed at attempted visit time/i);

  assert.equal(service.evaluateTimelineRowAgainstOperatingHours({
    timeRange: '07:00 AM - 08:00 AM',
    timings: 'Open 24 hours',
  }).valid, true);
});

test('allows up to 30 minutes of closing tolerance only for visits longer than four hours', () => {
  const service = createService();

  const overnightVisit = {
    type: 'attraction',
    locationId: 71,
    timeRange: '06:02 PM - 02:02 AM',
    timings: '09:00 AM - 06:00 PM',
  };
  assert.equal(service.evaluateTimelineRowAgainstOperatingHours(overnightVisit).valid, false);
  assert.equal(service.getSelectedManualClosingOverflow({
    timeline: [overnightVisit],
    selectedHotspotIds: [71],
  }).overflowMinutes, 8 * 60 + 2);

  const threeMinuteOverrun = {
    type: 'attraction',
    locationId: 73,
    timeRange: '10:03 AM - 06:03 PM',
    timings: '09:00 AM - 06:00 PM',
  };
  assert.equal(service.evaluateTimelineRowAgainstOperatingHours(threeMinuteOverrun).valid, true);
  assert.equal(service.getSelectedManualClosingOverflow({
    timeline: [threeMinuteOverrun],
    selectedHotspotIds: [73],
  }).hasClosingOverflow, false);

  const thirtyOneMinuteOverrun = {
    ...threeMinuteOverrun,
    timeRange: '10:03 AM - 06:31 PM',
  };
  assert.equal(service.evaluateTimelineRowAgainstOperatingHours(thirtyOneMinuteOverrun).valid, false);
  assert.equal(service.getSelectedManualClosingOverflow({
    timeline: [thirtyOneMinuteOverrun],
    selectedHotspotIds: [73],
  }).overflowMinutes, 31);

  assert.equal(service.evaluateTimelineRowAgainstOperatingHours({
    timeRange: '09:02 AM - 05:02 PM',
    timings: '09:00 AM - 06:00 PM',
  }).valid, true);
});

test('keeps valid overnight visits and rejects visits extending beyond overnight closing', () => {
  const service = createService();

  assert.equal(service.evaluateTimelineRowAgainstOperatingHours({
    timeRange: '11:00 PM - 01:00 AM',
    timings: '10:00 PM - 02:00 AM',
  }).valid, true);
  assert.equal(service.evaluateTimelineRowAgainstOperatingHours({
    timeRange: '01:00 AM - 03:00 AM',
    timings: '10:00 PM - 02:00 AM',
  }).valid, false);
  assert.equal(service.getSelectedManualClosingOverflow({
    timeline: [{
      type: 'attraction',
      locationId: 72,
      timeRange: '11:00 PM - 03:00 AM',
      timings: '10:00 PM - 02:00 AM',
    }],
    selectedHotspotIds: [72],
  }).overflowMinutes, 60);
});

test('waits until opening time when the visit duration fits the next window', () => {
  const service = createService();

  assert.deepEqual(service.adjustManualFitVisitStartToOperatingWindow({
    timings: '09:00 AM - 06:00 PM',
  }, 8 * 60, 60), {
    valid: true,
    startMinutes: 9 * 60,
    waitingMinutes: 60,
    operatingHours: '09:00 AM - 06:00 PM',
  });
});
