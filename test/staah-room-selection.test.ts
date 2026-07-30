import assert from 'node:assert/strict';
import test from 'node:test';
import { StaahBookingPushService } from '../src/modules/itineraries/services/staah-booking-push.service';

test('builds independent STAAH room payloads for different room and rate selections', async () => {
  const rowsBySelection: Record<string, any> = {
    'DELUXEROOM|CP_PLAN': {
      occupancy_rates: { DOUBLE: 900 },
      start_date: new Date('2026-08-01T00:00:00.000Z'),
      end_date: new Date('2026-08-03T00:00:00.000Z'),
      received_at: new Date('2026-07-30T00:00:00.000Z'),
    },
    'SUITEROOM|EP_PLAN': {
      occupancy_rates: { DOUBLE: 1200 },
      start_date: new Date('2026-08-01T00:00:00.000Z'),
      end_date: new Date('2026-08-03T00:00:00.000Z'),
      received_at: new Date('2026-07-30T00:00:00.000Z'),
    },
  };
  const service = new StaahBookingPushService({
    staah_rate: {
      findMany: async ({ where }: any) => {
        const row = rowsBySelection[`${where.room_id}|${where.rateplan_id}`];
        return row ? [row] : [];
      },
    },
  } as any);

  const payloads = await (service as any).buildStaahRoomPayloadsFromRateRows({
    propertyId: '44596',
    checkInDate: '2026-08-01',
    checkOutDate: '2026-08-03',
    roomProfiles: [
      {
        adults: 2,
        children: 0,
        childWithBedCount: 0,
        childWithoutBedCount: 0,
        extraBedCount: 0,
        roomId: 'DELUXEROOM',
        rateId: 'CP_PLAN',
        rateName: 'Continental Plan',
        roomType: 'Deluxe Room',
      },
      {
        adults: 2,
        children: 0,
        childWithBedCount: 0,
        childWithoutBedCount: 0,
        extraBedCount: 0,
        roomId: 'SUITEROOM',
        rateId: 'EP_PLAN',
        rateName: 'European Plan',
        roomType: 'Suite Room',
      },
    ],
  });

  assert.equal(payloads.length, 2);
  assert.deepEqual(
    payloads.map((room: any) => [room.roomId, room.rateId, room.roomType, room.rateName, room.amountAfterTax]),
    [
      ['DELUXEROOM', 'CP_PLAN', 'Deluxe Room', 'Continental Plan', 1800],
      ['SUITEROOM', 'EP_PLAN', 'Suite Room', 'European Plan', 2400],
    ],
  );
});
