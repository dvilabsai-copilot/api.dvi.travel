import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelBlockingService } from '../src/modules/itineraries/services/hotel-blocking.service';

function serviceWithPlan(itineraryPreference: number, selectedRows: any[] = [], requests: any[] = []) {
  const calls = { selectedRows: 0, requests: 0 };
  const service = new HotelBlockingService(
    {
      dvi_itinerary_plan_details: {
        findUnique: async () => ({ itinerary_preference: itineraryPreference }),
      },
      dvi_itinerary_plan_hotel_details: {
        findMany: async () => {
          calls.selectedRows += 1;
          return selectedRows;
        },
      },
      dvi_hotel_block_request: {
        findMany: async () => {
          calls.requests += 1;
          return requests;
        },
      },
    } as any,
    {} as any,
  );
  return { service, calls };
}

test('vehicle-only plans bypass hotel readiness checks', async () => {
  const { service, calls } = serviceWithPlan(2, [{ itinerary_plan_hotel_details_ID: 101 }], []);

  const result = await service.assertPlanReady(12032, 1);

  assert.deepEqual(result, { ready: true, requestCount: 0 });
  assert.equal(calls.selectedRows, 0);
  assert.equal(calls.requests, 0);
});

test('hotel-inclusive plans still require every selected hotel to be confirmed', async () => {
  const { service, calls } = serviceWithPlan(
    1,
    [{ itinerary_plan_hotel_details_ID: 101 }],
    [{ id: 7, hotel_name: 'Test Hotel', status: 'REQUESTED', selection_ids: '[101]' }],
  );

  await assert.rejects(
    service.assertPlanReady(12032, 1),
    (error: any) => {
      assert.equal(error?.response?.code, 'HOTEL_CONFIRMATION_PENDING');
      assert.equal(error?.response?.message, 'Confirm & Pay is available only after every selected hotel confirms the stay.');
      return true;
    },
  );
  assert.equal(calls.selectedRows, 1);
  assert.equal(calls.requests, 1);
});

test('an active AxisRooms unpaid hold is ready for the wallet confirmation step', async () => {
  const { service } = serviceWithPlan(
    1,
    [{ itinerary_plan_hotel_details_ID: 101 }],
    [{
      id: 8,
      hotel_name: 'Axis Hotel',
      provider: 'AXISROOMS',
      status: 'BLOCKED',
      confirmation_channel: 'AXISROOMS_HOLD',
      confirmation_reference: 'DVI-HOLD-12032-101-AX1',
      cutoff_at: new Date(Date.now() + 4 * 60 * 60 * 1000),
      selection_ids: '[101]',
    }],
  );

  assert.deepEqual(await service.assertPlanReady(12032, 1), { ready: true, requestCount: 1 });
});

test('provider holds keep at least four hours and AxisRooms cannot outlive its one-day-before cutoff', () => {
  const { service } = serviceWithPlan(1);
  const minimumPolicy = {
    noBlockBeforeHours: 48,
    minimumLeadDays: 3,
    shortLeadDays: 1,
    mediumLeadDays: 2,
    shortDurationHours: 2,
    mediumDurationHours: 6,
    longDurationHours: 2,
    tboHoldLcdBufferDays: 1,
  };
  const longPolicy = { ...minimumPolicy, longDurationHours: 120 };
  const requestedAt = new Date('2026-01-01T10:00:00.000Z');

  const offlineCutoff = (service as any).getProviderHoldCutoff('2026-01-16', requestedAt, minimumPolicy, 'OFFLINE_HOLD');
  const axisCutoff = (service as any).getProviderHoldCutoff('2026-01-04', requestedAt, longPolicy, 'AXISROOMS_HOLD');

  assert.equal(offlineCutoff.toISOString(), '2026-01-01T14:00:00.000Z');
  assert.equal(axisCutoff.toISOString(), '2026-01-03T00:00:00.000Z');
});

test('an active offline local hold is ready for wallet confirmation without a supplier reference', async () => {
  const { service } = serviceWithPlan(
    1,
    [{ itinerary_plan_hotel_details_ID: 101 }],
    [{
      id: 9,
      hotel_name: 'Offline Hotel',
      provider: 'OFFLINE',
      status: 'BLOCKED',
      confirmation_channel: 'OFFLINE_HOLD',
      confirmation_reference: null,
      cutoff_at: new Date(Date.now() + 4 * 60 * 60 * 1000),
      selection_ids: '[101]',
    }],
  );

  assert.deepEqual(await service.assertPlanReady(12032, 1), { ready: true, requestCount: 1 });
});

test('post-payment finalization records AxisRooms and offline confirmations without another supplier call', async () => {
  const updatedRequests: any[] = [];
  const createdAxisRows: any[] = [];
  const events: any[] = [];
  const requests = [
    {
      id: 21,
      status: 'BLOCKED',
      confirmation_channel: 'AXISROOMS_HOLD',
      confirmation_reference: 'DVI-HOLD-12032-101-AX1',
      selection_ids: '[101]',
      hotel_code: 'AX-10',
      room_count: 1,
      created_by: 9,
      request_payload: JSON.stringify({
        providerHold: {
          request: {
            confirmationNo: 'DVI-HOLD-12032-101-AX1',
            hotelId: '10',
            checkInDate: '2027-01-10',
            checkOutDate: '2027-01-11',
            totalAmount: '5000',
            roomStays: [{ rateId: 'AX-RATE-1', noOfUnits: '1', guestDetails: { adults: 2, children: 1 } }],
          },
          response: { status: 'success' },
        },
      }),
    },
    {
      id: 22,
      status: 'BLOCKED',
      confirmation_channel: 'OFFLINE_HOLD',
      selection_ids: '[102]',
    },
  ];
  const prisma: any = {
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        findMany: async () => requests,
        update: async ({ where, data }: any) => { updatedRequests.push({ where, data }); return { id: where.id, ...data }; },
      },
      dvi_itinerary_plan_hotel_details: {
        findMany: async () => [
          { itinerary_plan_hotel_details_ID: 101, itinerary_route_id: 901 },
          { itinerary_plan_hotel_details_ID: 102, itinerary_route_id: 902 },
        ],
      },
      axisrooms_hotel_booking_confirmation: {
        findFirst: async () => null,
        create: async ({ data }: any) => { createdAxisRows.push(data); return data; },
      },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    }),
  };
  const service = new (HotelBlockingService as any)(prisma, {}, {});

  const result = await service.finalizePaidProviderHolds(12032, 1, 888);

  assert.deepEqual(result, { finalized: 2 });
  assert.equal(createdAxisRows.length, 1);
  assert.equal(createdAxisRows[0].confirmed_itinerary_plan_ID, 888);
  assert.equal(createdAxisRows[0].itinerary_route_ID, 901);
  assert.equal(createdAxisRows[0].axisrooms_booking_reference, 'DVI-HOLD-12032-101-AX1');
  assert.equal(createdAxisRows[0].net_amount, 5000);
  assert.equal(updatedRequests.length, 2);
  assert.ok(updatedRequests.every((entry) => entry.data.status === 'CONFIRMED'));
  assert.equal(events.length, 2);
});
