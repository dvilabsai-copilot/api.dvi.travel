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
