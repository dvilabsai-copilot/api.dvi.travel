import assert from 'node:assert/strict';
import test from 'node:test';
import { getRouteHotspotOperatingStatus } from '../src/modules/itineraries/utils/route-hotspot-operating-hours.util';

function createPrisma(routeDate: string, timingRows: any[]) {
  let timingWhere: any = null;
  return {
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_date: new Date(routeDate) }),
    },
    dvi_hotspot_timing: {
      findMany: async (args: any) => {
        timingWhere = args.where;
        return timingRows;
      },
    },
    get timingWhere() {
      return timingWhere;
    },
  } as any;
}

test('evaluates the route weekday and reports an explicit closure', async () => {
  const prisma = createPrisma('2026-07-28T00:00:00.000Z', [
    { hotspot_closed: 1, hotspot_timing_day: 1 },
    { hotspot_closed: 0, hotspot_timing_day: 0 },
  ]);

  const status = await getRouteHotspotOperatingStatus(prisma, 9933, 9272, 10);

  assert.equal(prisma.timingWhere.hotspot_timing_day, undefined);
  assert.equal(status.routeDayLabel, 'Tuesday');
  assert.equal(status.operatingHours, 'Closed');
  assert.equal(status.isClosedOnRouteDate, true);
  assert.deepEqual(status.closedDays, ['Tuesday']);
  assert.equal(status.closedDaysLabel, 'Tuesday');
});

test('keeps the same hotspot available on an open weekday', async () => {
  const prisma = createPrisma('2026-07-27T00:00:00.000Z', [
    {
      hotspot_closed: 0,
      hotspot_timing_day: 0,
      hotspot_start_time: new Date('2020-01-01T09:00:00.000Z'),
      hotspot_end_time: new Date('2020-01-01T17:30:00.000Z'),
    },
  ]);

  const status = await getRouteHotspotOperatingStatus(prisma, 9933, 9271, 10);

  assert.equal(prisma.timingWhere.hotspot_timing_day, undefined);
  assert.equal(status.routeDayLabel, 'Monday');
  assert.equal(status.operatingHours, '09:00 AM - 05:30 PM');
  assert.equal(status.isClosedOnRouteDate, false);
});

test('labels a hotspot closed on every weekday as all days', async () => {
  const prisma = createPrisma('2026-07-28T00:00:00.000Z',
    Array.from({ length: 7 }, (_, hotspot_timing_day) => ({ hotspot_closed: 1, hotspot_timing_day })));

  const status = await getRouteHotspotOperatingStatus(prisma, 9933, 9272, 10);

  assert.deepEqual(status.closedDays, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  assert.equal(status.closedDaysLabel, 'all days');
  assert.equal(status.operatingHours, 'Closed');
  assert.equal(status.isClosedOnRouteDate, true);
});
