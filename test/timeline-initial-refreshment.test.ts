import assert from 'node:assert/strict';
import test from 'node:test';
import { TimelineInitialRefreshmentService } from '../src/modules/itineraries/engines/helpers/timeline-initial-refreshment.service';

const timeToSeconds = (value: string) => {
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
};

const addSeconds = (value: string, seconds: number) => {
  const total = timeToSeconds(value) + seconds;
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
};

test('adds a fitting refreshment row and advances order/time', async () => {
  const service = new TimelineInitialRefreshmentService();
  const result = await service.apply({
    tx: { dvi_global_settings: { findFirst: async () => ({ itinerary_common_buffer_time: '01:00:00' }) } },
    planId: 10,
    route: { itinerary_route_ID: 20 },
    isLastRoute: false,
    skipInitialRefreshmentForImmediateHotelCheckin: false,
    enforceStrictDay1EarlyArrivalDeferredFlow: false,
    firstSightseeingMovementTime: null,
    isTransferOnlyLastRouteByReportDeadline: false,
    currentTime: '08:00:00',
    routeEndSeconds: timeToSeconds('18:00:00'),
    order: 1,
    createdByUserId: 1,
    timeToSeconds,
    addSeconds,
  });

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].itinerary_plan_ID, 10);
  assert.equal(result.rows[0].itinerary_route_ID, 20);
  assert.equal(result.rows[0].hotspot_order, 1);
  assert.equal(result.currentTime, '09:00:00');
  assert.equal(result.order, 2);
});

test('advances the last route without creating a refreshment row', async () => {
  const result = await new TimelineInitialRefreshmentService().apply({
    tx: { dvi_global_settings: { findFirst: async () => ({ itinerary_common_buffer_time: '00:30:00' }) } },
    planId: 10,
    route: { itinerary_route_ID: 20 },
    isLastRoute: true,
    skipInitialRefreshmentForImmediateHotelCheckin: false,
    enforceStrictDay1EarlyArrivalDeferredFlow: false,
    firstSightseeingMovementTime: null,
    isTransferOnlyLastRouteByReportDeadline: false,
    currentTime: '17:00:00',
    routeEndSeconds: timeToSeconds('18:00:00'),
    order: 2,
    createdByUserId: 1,
    timeToSeconds,
    addSeconds,
  });

  assert.deepEqual(result.rows, []);
  assert.equal(result.currentTime, '17:30:00');
  assert.equal(result.order, 2);
});

test('does not query settings when initial refreshment is explicitly skipped', async () => {
  let reads = 0;
  const result = await new TimelineInitialRefreshmentService().apply({
    tx: { dvi_global_settings: { findFirst: async () => { reads++; return null; } } },
    planId: 10,
    route: { itinerary_route_ID: 20 },
    isLastRoute: false,
    skipInitialRefreshmentForImmediateHotelCheckin: true,
    enforceStrictDay1EarlyArrivalDeferredFlow: false,
    firstSightseeingMovementTime: null,
    isTransferOnlyLastRouteByReportDeadline: false,
    currentTime: '08:00:00',
    routeEndSeconds: timeToSeconds('18:00:00'),
    order: 1,
    createdByUserId: 1,
    timeToSeconds,
    addSeconds,
  });

  assert.equal(reads, 0);
  assert.deepEqual(result, { rows: [], currentTime: '08:00:00', order: 1 });
});
