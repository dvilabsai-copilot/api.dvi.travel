import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_HOTEL_HOLD_POLICY, HotelBlockingService, hotelHoldDecision } from '../src/modules/itineraries/services/hotel-blocking.service';

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

test('an active TBO refundable Book hold is ready for Confirm & Pay before voucher generation', async () => {
  const { service } = serviceWithPlan(
    1,
    [{ itinerary_plan_hotel_details_ID: 101 }],
    [{
      id: 10,
      hotel_name: 'VSR Hotel',
      provider: 'VSR',
      status: 'BLOCKED',
      confirmation_channel: 'TBO_BOOK_HOLD',
      confirmation_reference: 'TBO-BOOK-10',
      cutoff_at: new Date(Date.now() + 4 * 60 * 60 * 1000),
      selection_ids: '[101]',
      request_payload: JSON.stringify({ supplierHold: { bookingId: 10, bookingReference: 'TBO-BOOK-10', bookingCode: 'rate!TB!1' } }),
    }],
  );

  assert.deepEqual(await service.assertPlanReady(12032, 1), { ready: true, requestCount: 1 });
});

test('provider hold cutoffs use policy duration and AxisRooms one-day-before cutoff', () => {
  const { service } = serviceWithPlan(1);
  const minimumPolicy = {
    noBlockBeforeHours: 48,
    minimumLeadDays: 3,
    shortLeadDays: 15,
    mediumLeadDays: 30,
    longLeadDays: 60,
    shortDurationHours: 48,
    mediumDurationHours: 12,
    longDurationHours: 48,
    extendedDurationHours: 240,
    tboHoldLcdBufferDays: 1,
  };
  const requestedAt = new Date('2026-01-01T10:00:00.000Z');

  const offlineCutoff = (service as any).getProviderHoldCutoff('2026-01-16', requestedAt, minimumPolicy, 'OFFLINE_HOLD');
  const axisCutoff = (service as any).getProviderHoldCutoff('2026-01-04', requestedAt, minimumPolicy, 'AXISROOMS_HOLD');

  assert.equal(offlineCutoff.toISOString(), '2026-01-03T10:00:00.000Z');
  assert.equal(axisCutoff.toISOString(), '2026-01-03T00:00:00.000Z');
});

test('hotel hold date boundaries use the four configured calendar-day bands', () => {
  const requestedAt = new Date('2026-01-01T00:00:00.000Z');
  const cases = [
    [0, false, null], [1, false, null], [2, false, null],
    [3, true, 48], [15, true, 48], [16, true, 12], [30, true, 12],
    [31, true, 48], [60, true, 48], [61, true, 240], [75, true, 240], [90, true, 240],
  ] as const;

  for (const [days, allowed, durationHours] of cases) {
    const checkIn = new Date(requestedAt.getTime() + days * 86_400_000).toISOString().slice(0, 10);
    const result = hotelHoldDecision(checkIn, requestedAt, DEFAULT_HOTEL_HOLD_POLICY);
    assert.equal(result.allowed, allowed, `lead day ${days}`);
    assert.equal(result.durationHours, durationHours, `duration at lead day ${days}`);
  }
});

test('default hold eligibility rejects 48 hours or less and permits more than 48 hours', () => {
  const requestedAt = new Date('2026-01-01T10:00:00.000Z');
  const cases = [
    ['2026-01-03T08:59:00.000Z', false],
    ['2026-01-03T10:00:00.000Z', false],
    ['2026-01-03T10:01:00.000Z', true],
  ] as const;

  for (const [checkIn, allowed] of cases) {
    assert.equal(hotelHoldDecision(checkIn, requestedAt).allowed, allowed, checkIn);
  }
});


test('invalid hotel check-in dates fail closed', () => {
  const result = hotelHoldDecision('not-a-date', new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'invalid check-in or request date');
});

test('configured no-block hours prevent holds even when a lead day is in an eligible band', () => {
  const requestedAt = new Date('2026-01-01T00:00:00.000Z');
  const result = hotelHoldDecision('2026-01-04', requestedAt, { ...DEFAULT_HOTEL_HOLD_POLICY, noBlockBeforeHours: 100 });
  assert.equal(result.leadDays, 3);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'check-in is within the configured 100-hour no-block window');
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

test('manual cancellation queues durable inventory release for an unpaid accepted hold', async () => {
  const request = {
    id: 21,
    status: 'CONFIRMED',
    confirmation_channel: 'OFFLINE_HOLD',
    cutoff_at: new Date(Date.now() + 60 * 60 * 1000),
    requested_at: new Date(),
    check_in: new Date(Date.now() + 10 * 86_400_000),
    check_out: new Date(Date.now() + 11 * 86_400_000),
    paid_confirmed_at: null,
    contact_email: 'hotel@example.test',
  };
  const updates: any[] = [];
  const events: any[] = [];
  const prisma: any = {
    dvi_hotel_block_request: { findUnique: async () => request },
    dvi_global_settings: { findFirst: async () => null },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
      dvi_hotel_block_request: { update: async ({ data }: any) => { updates.push(data); return { ...request, ...data }; } },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    }),
  };
  const service = new HotelBlockingService(prisma, {} as any, {} as any);

  await service.cancel(request.id, { id: 7, type: 'STAFF' });

  assert.equal(updates[0].status, 'CANCELLED');
  assert.equal(updates[0].release_status, 'PENDING');
  assert.equal(updates[0].release_email_status, 'PENDING');
  assert.equal(events[0].event_type, 'CANCELLED');
});

test('manual cancellation cannot cancel a paid hotel confirmation', async () => {
  const request = {
    id: 22,
    status: 'CONFIRMED',
    cutoff_at: new Date(Date.now() + 60 * 60 * 1000),
    paid_confirmed_at: new Date(),
  };
  let transactionStarted = false;
  const service = new HotelBlockingService({
    dvi_hotel_block_request: { findUnique: async () => request },
    dvi_global_settings: { findFirst: async () => null },
    $transaction: async () => { transactionStarted = true; },
  } as any, {} as any, {} as any);

  await assert.rejects(service.cancel(request.id, { id: 7, type: 'STAFF' }), /paid.*confirmed/i);
  assert.equal(transactionStarted, false);
});

test('offline cancelled holds can record manual supplier-release acknowledgement', async () => {
  const request = {
    id: 23,
    status: 'CANCELLED',
    confirmation_channel: 'OFFLINE_HOLD',
    release_status: 'REQUESTED',
    requested_at: new Date(),
    check_in: new Date(Date.now() + 10 * 86_400_000),
  };
  let updateWhere: any;
  const events: any[] = [];
  const prisma: any = {
    dvi_hotel_block_request: { findUnique: async () => request },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
      dvi_hotel_block_request: {
        updateMany: async ({ where }: any) => { updateWhere = where; return { count: 1 }; },
        findUnique: async () => ({ ...request, release_status: 'ACKNOWLEDGED' }),
      },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    }),
  };
  const service = new HotelBlockingService(prisma, {} as any, {} as any);

  const result = await service.recordReleaseAcknowledgement(request.id, { id: 7, type: 'STAFF' });

  assert.equal(updateWhere.status, 'CANCELLED');
  assert.equal(result.request.status, 'CANCELLED');
  assert.equal(result.request.releaseStatus, 'ACKNOWLEDGED');
  assert.equal(events[0].previous_status, 'CANCELLED');
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

  const result = await service.finalizePaidProviderHolds(12032, 1, 888, [{ requestId: 22, confirmed: true }]);

  assert.deepEqual(result, { finalized: 2, voucherResults: [] });
  assert.equal(createdAxisRows.length, 1);
  assert.equal(createdAxisRows[0].confirmed_itinerary_plan_ID, 888);
  assert.equal(createdAxisRows[0].itinerary_route_ID, 901);
  assert.equal(createdAxisRows[0].axisrooms_booking_reference, 'DVI-HOLD-12032-101-AX1');
  assert.equal(createdAxisRows[0].net_amount, 5000);
  assert.equal(updatedRequests.length, 2);
  assert.ok(updatedRequests.every((entry) => entry.data.status === 'CONFIRMED'));
  assert.equal(events.length, 2);
  assert.equal(events[1].event_type, 'OFFLINE_HOTEL_PAYMENT_CONFIRMED');
});

test('a TBO voucher failure remains pending without undoing AxisRooms or offline payment finalization', async () => {
  const updates: any[] = [];
  const events: any[] = [];
  const requests = [
    {
      id: 31,
      status: 'BLOCKED',
      confirmation_channel: 'AXISROOMS_HOLD',
      confirmation_reference: 'AX-HOLD-31',
      selection_ids: '[301]',
      hotel_code: 'AX-31',
      request_payload: JSON.stringify({ providerHold: { request: { confirmationNo: 'AX-HOLD-31', roomStays: [] } } }),
    },
    {
      id: 32,
      status: 'BLOCKED',
      confirmation_channel: 'OFFLINE_HOLD',
      selection_ids: '[302]',
      request_payload: JSON.stringify({ providerHold: { hotelierContact: { name: 'Offline Desk', phone: '12345' } } }),
    },
    {
      id: 33,
      status: 'BLOCKED',
      confirmation_channel: 'TBO_BOOK_HOLD',
      confirmation_reference: 'TBO-BOOK-33',
      selection_ids: '[303]',
      voucher_status: 'UNVOUCHERED',
      voucher_attempt_count: 0,
      request_payload: JSON.stringify({ supplierHold: { bookingId: 3300, bookingReference: 'TBO-BOOK-33' } }),
    },
  ];
  const prisma: any = {
    dvi_hotel_block_request: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => ({ ...requests[2], voucher_status: 'PROCESSING', voucher_attempt_count: 1 }),
    },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        findMany: async () => requests,
        update: async ({ where, data }: any) => { updates.push({ id: where.id, data }); return { id: where.id, ...data }; },
      },
      dvi_itinerary_plan_hotel_details: {
        findMany: async () => [
          { itinerary_plan_hotel_details_ID: 301, itinerary_route_id: 901 },
          { itinerary_plan_hotel_details_ID: 302, itinerary_route_id: 902 },
          { itinerary_plan_hotel_details_ID: 303, itinerary_route_id: 903 },
        ],
      },
      axisrooms_hotel_booking_confirmation: {
        findFirst: async () => null,
        create: async ({ data }: any) => data,
      },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    }),
  };
  const tbo = {
    getHoldStatus: async () => ({ voucherStatus: false, status: 'Confirmed' }),
    generateVoucher: async () => { throw new Error('Insufficient Balance'); },
  };
  const service = new (HotelBlockingService as any)(prisma, {}, tbo);

  const result = await service.finalizePaidProviderHolds(12032, 1, 888, [
    { requestId: 32, confirmed: true, hotelierName: 'Offline Desk', hotelierPhone: '12345' },
  ]);

  assert.equal(result.finalized, 3);
  assert.equal(result.voucherResults[0].status, 'PENDING');
  assert.ok(updates.some((entry) => entry.id === 31 && entry.data.status === 'CONFIRMED'));
  assert.ok(updates.some((entry) => entry.id === 32 && entry.data.status === 'CONFIRMED'));
  assert.ok(updates.some((entry) => entry.id === 33 && entry.data.voucher_status === 'PENDING'));
  assert.ok(events.some((event) => event.event_type === 'OFFLINE_HOTEL_PAYMENT_CONFIRMED'));
  assert.ok(events.some((event) => event.event_type === 'TBO_VOUCHER_PENDING'));
});

test('the voucher scheduler retries a paid TBO hold and marks it vouchered when a later attempt succeeds', async () => {
  const updates: any[] = [];
  const events: any[] = [];
  const request = {
    id: 35,
    status: 'CONFIRMED',
    confirmation_channel: 'TBO_BOOK_HOLD',
    confirmation_reference: 'TBO-BOOK-35',
    paid_confirmed_at: new Date(),
    voucher_status: 'PENDING',
    voucher_attempt_count: 1,
    request_payload: JSON.stringify({
      supplierHold: {
        bookingId: 3500,
        bookingReference: 'TBO-BOOK-35',
        lcdDeadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      },
    }),
  };
  let updateManyCalls = 0;
  const prisma: any = {
    dvi_hotel_block_request: {
      updateMany: async () => ({ count: ++updateManyCalls === 1 ? 0 : 1 }),
      findMany: async () => [request],
      findUnique: async () => request,
    },
    $transaction: async (callback: (tx: any) => Promise<any>) => callback({
      dvi_hotel_block_request: {
        update: async ({ where, data }: any) => { updates.push({ id: where.id, data }); return { id: where.id, ...data }; },
      },
      dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    }),
  };
  let voucherCalls = 0;
  const tbo = {
    getHoldStatus: async () => ({ voucherStatus: false, status: 'Confirmed' }),
    generateVoucher: async () => {
      voucherCalls += 1;
      return { voucherStatus: true, bookingStatus: 'Confirmed', bookingId: 3500 };
    },
  };
  const service = new (HotelBlockingService as any)(prisma, {}, tbo);

  const result = await service.retryDueTboVouchers(new Date());

  assert.deepEqual(result, { processed: 1, recoveredClaims: 0 });
  assert.equal(voucherCalls, 1);
  assert.ok(updates.some((entry) => entry.data.voucher_status === 'VOUCHERED'));
  assert.ok(events.some((event) => event.event_type === 'TBO_VOUCHER_GENERATED'));
});

test('offline payment acknowledgement is restricted to Travel Experts and requires hotelier contact details', async () => {
  const service = new HotelBlockingService({
    dvi_hotel_block_request: { findMany: async () => [{ id: 44, hotel_name: 'Offline Hotel' }] },
  } as any, {} as any, {} as any);

  await assert.rejects(
    service.assertOfflinePaymentAcknowledgements(12032, 1, [], { roleId: 4 }),
    /Only a Travel Expert/i,
  );
  await assert.rejects(
    service.assertOfflinePaymentAcknowledgements(12032, 1, [{ requestId: 44, confirmed: true }], { roleId: 8 }),
    (error: any) => error?.response?.code === 'OFFLINE_HOTEL_PAYMENT_ACKNOWLEDGEMENT_REQUIRED',
  );
  assert.deepEqual(
    await service.assertOfflinePaymentAcknowledgements(
      12032,
      1,
      [{ requestId: 44, confirmed: true, hotelierName: 'Front Desk', hotelierPhone: '12345' }],
      { roleId: 8 },
    ),
    { required: 1 },
  );
});
