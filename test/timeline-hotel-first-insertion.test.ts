import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimelineHotelFirstInsertionService } from '../src/modules/itineraries/engines/helpers/timeline-hotel-first-insertion.service';

function createService(logs: any[]) {
  const hotelBuilder = {
    buildToHotel: async (_tx: any, opts: any) => ({
      row: { item_type: 5, hotspot_order: opts.order, hotspot_end_time: 'old' },
      nextTime: '10:00:00',
    }),
    buildReturnToHotel: async (_tx: any, opts: any) => ({
      row: { item_type: 6, hotspot_order: opts.order },
      nextTime: '10:15:00',
    }),
  };
  const refreshmentBuilder = {
    build: (planId: number, routeId: number, order: number, startTime: string, duration: string) => ({
      row: { item_type: 1, planId, routeId, hotspot_order: order, startTime, duration },
      nextTime: duration === '01:00:00' ? '11:15:00' : '12:15:00',
    }),
  };
  const service = new TimelineHotelFirstInsertionService(hotelBuilder as any, refreshmentBuilder as any);
  service.setCallbacks({ logBookingRule: (payload) => logs.push(payload) });
  return service;
}

const baseInput = {
  tx: {} as any,
  planId: 7,
  routeId: 11,
  plan: { quote_id: 'q1' },
  currentTime: '09:00:00',
  currentLocationName: 'Chennai',
  currentCoords: { lat: 13, lon: 80 },
  destinationLocationName: 'Chennai',
  destinationCoords: { lat: 13, lon: 80 },
  hotelInfo: { hotelName: 'Hotel Chennai', coords: { lat: 13, lon: 80 } },
  order: 1,
  createdByUserId: 1,
  isLastRoute: false,
  suppressHotelInsertionUntilEndOfDay: false,
  isEarlyArrivalPrevDayConfirmed: false,
  isSpecialDay1OnePmHotelFirstFlow: false,
  shouldHotelFirstByDistance: true,
  hotelDistanceFromArrivalKm: 5,
  isArrivalAfterNoon: true,
};

test('inserts hotel travel, check-in and rest rows with preserved state updates', async () => {
  const logs: any[] = [];
  const result = await createService(logs).insert(baseInput);
  assert.deepEqual(result.rows.map((row) => row.item_type), [5, 6, 1]);
  assert.equal(result.rows[0].hotspot_end_time instanceof Date, true);
  assert.equal(result.order, 3);
  assert.equal(result.currentTime, '12:15:00');
  assert.equal(result.currentLocationName, 'Hotel');
  assert.equal(result.didHotelFirstCheckin, true);
  assert.ok(logs.some((entry) => entry.rule === 'HOTEL_FIRST_SELECTED'));
  assert.ok(logs.some((entry) => entry.rule === 'REST_GAP_INSERTED'));
});

test('does not insert when route policy suppresses hotel-first flow', async () => {
  const result = await createService([]).insert({
    ...baseInput,
    suppressHotelInsertionUntilEndOfDay: true,
  });
  assert.deepEqual(result.rows, []);
  assert.equal(result.order, baseInput.order);
  assert.equal(result.didHotelFirstCheckin, false);
});

test('uses a three-hour break after confirmed early check-in', async () => {
  const logs: any[] = [];
  const result = await createService(logs).insert({
    ...baseInput,
    isEarlyArrivalPrevDayConfirmed: true,
    shouldHotelFirstByDistance: false,
    isArrivalAfterNoon: false,
  });

  assert.equal(result.rows[2].duration, '03:00:00');
  assert.ok(logs.some((entry) => entry.rule === 'REST_GAP_INSERTED' && entry.restMinutes === 180));
});
