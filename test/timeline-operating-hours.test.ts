import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineOperatingHoursService } from '../src/modules/itineraries/engines/helpers/timeline-operating-hours.service';

const service = new TimelineOperatingHoursService();

function timingMap(records: any[]) {
  return new Map([[41, new Map([[2, records]])]]);
}

test('summarizes open windows and recognizes closed days', () => {
  const map = timingMap([
    { hotspot_start_time: '09:00:00', hotspot_end_time: '12:00:00' },
    { hotspot_start_time: '14:00:00', hotspot_end_time: '18:00:00' },
  ]);
  assert.deepEqual(service.getTimingWindowSummary(map, 41, 2), { openingTime: '09:00:00', closingTime: '18:00:00' });
  assert.equal(service.isHotspotClosedOnDay(map, 41, 2), false);
});

test('returns a closed result when no timing is configured', () => {
  const result = service.checkHotspotOperatingHoursFromMap(new Map(), 41, 2, 10 * 3600, 11 * 3600);
  assert.deepEqual(result, { canVisitNow: false, nextWindowStart: null, isClosedForDay: true });
});

test('supports overnight operating windows using absolute end time', () => {
  const map = timingMap([{ hotspot_start_time: '18:00:00', hotspot_end_time: '08:00:00' }]);
  assert.equal(service.checkHotspotOperatingHoursFromMap(map, 41, 2, 19 * 3600, 25 * 3600).canVisitNow, true);
});
