import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelHoldExpiryScheduler } from '../src/modules/itineraries/services/hotel-hold-expiry.scheduler';

const createScheduler = (rows: any[]) => {
  const events: any[] = [];
  const notices: any[] = [];
  const requests = new Map(rows.map((row) => [row.id, { ...row }]));
  const requestModel = {
    findMany: async ({ where }: any) => {
      const values = [...requests.values()];
      if (where?.status === 'EXPIRED' || where?.status?.in?.includes('CANCELLED')) {
        return values.filter((row) => ['EXPIRED', 'CANCELLED'].includes(row.status)
          && !row.paid_confirmed_at
          && (['PENDING', 'FAILED'].includes(row.release_status) || ['PENDING', 'FAILED'].includes(row.release_email_status)));
      }
      return values.filter((row) => ['BLOCKED', 'CONFIRMED'].includes(row.status)
        && !row.paid_confirmed_at && new Date(row.cutoff_at).getTime() <= new Date(where.cutoff_at.lte).getTime());
    },
    updateMany: async ({ where, data }: any) => {
      const row = requests.get(Number(where.id));
      if (!row || row.status !== where.status) return { count: 0 };
      if (where.paid_confirmed_at === null && row.paid_confirmed_at) return { count: 0 };
      if (where.cutoff_at?.lte && new Date(row.cutoff_at).getTime() > new Date(where.cutoff_at.lte).getTime()) return { count: 0 };
      if (where.release_status && ![].concat(where.release_status.in || where.release_status.notIn || [where.release_status]).includes(row.release_status)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
    update: async ({ where, data }: any) => {
      const row = requests.get(Number(where.id));
      Object.assign(row, data);
      return row;
    },
  };
  const prisma: any = {
    dvi_hotel_block_request: requestModel,
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: 'DVI-TEST', agent_id: 7, staff_id: 8 }) },
    dvi_agent: { findFirst: async () => ({ agent_name: 'Selected Agent', agent_email_id: 'agent@example.test', travel_expert_id: 8 }) },
    dvi_staff_details: { findFirst: async () => ({ staff_name: 'Assigned Expert', staff_email: 'expert@example.test' }) },
    dvi_hotel_hold_notification: { upsert: async ({ create }: any) => { notices.push(create); } },
    dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
      dvi_hotel_block_request: requestModel,
      dvi_hotel_block_event: prisma.dvi_hotel_block_event,
    }),
  };
  const scheduler = new HotelHoldExpiryScheduler(
    prisma,
    { isDispatchEnabled: () => false } as any,
    {} as any,
    {} as any,
  );
  return { scheduler, events, notices, requests };
};

test('expiry atomically expires an unpaid offline hold and queues hotel and agent notifications', async () => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const { scheduler, events, notices, requests } = createScheduler([{
    id: 41,
    itinerary_plan_id: 800,
    status: 'BLOCKED',
    paid_confirmed_at: null,
    cutoff_at: new Date('2026-11-05T11:59:00.000Z'),
    confirmation_channel: 'OFFLINE_HOLD',
    release_status: 'NOT_REQUIRED',
    release_email_status: 'NOT_REQUIRED',
    selection_ids: '[901]',
    request_payload: '{}',
    version: 1,
    contact_email: 'hotel@example.test',
  }]);

  const result = await scheduler.runOnce(now);

  assert.equal(result.expired, 1);
  assert.equal(requests.get(41)?.status, 'EXPIRED');
  assert.equal(requests.get(41)?.release_status, 'REQUESTED');
  assert.equal(events.some((event) => event.event_type === 'HOTEL_HOLD_EXPIRED'), true);
  assert.equal(notices.map((notice) => notice.notification_type).sort().join(','), 'AGENT_HOLD_EXPIRED_EMAIL,HOTEL_RELEASE_EMAIL');
});

test('expiry does not transition a paid hold', async () => {
  const { scheduler, requests } = createScheduler([{
    id: 42,
    itinerary_plan_id: 801,
    status: 'CONFIRMED',
    paid_confirmed_at: new Date('2026-11-05T11:00:00.000Z'),
    cutoff_at: new Date('2026-11-05T11:30:00.000Z'),
    confirmation_channel: 'OFFLINE_HOLD',
    release_status: 'NOT_REQUIRED',
  }]);

  const result = await scheduler.runOnce(new Date('2026-11-05T12:00:00.000Z'));

  assert.equal(result.expired, 0);
  assert.equal(requests.get(42)?.status, 'CONFIRMED');
});

test('test-routed hotel release email does not mark the hotelier as notified', async () => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const request: any = {
    id: 49, itinerary_plan_id: 805, status: 'EXPIRED', paid_confirmed_at: null,
    release_status: 'REQUESTED', release_email_status: 'PENDING',
    cutoff_at: new Date('2026-11-05T11:59:00.000Z'), release_requested_at: now,
    contact_email: 'hotel@real-domain.example', hotel_name: 'Test Hotel', provider: 'OFFLINE',
    check_in: new Date('2026-11-25T00:00:00.000Z'), check_out: new Date('2026-11-26T00:00:00.000Z'),
    room_type: 'Deluxe', meal_plan: 'CP', room_count: 1, request_payload: '{}', confirmation_reference: 'HOLD-49',
  };
  const notice: any = {
    id: 90, request_id: 49, request_version: 1, notification_type: 'HOTEL_RELEASE_EMAIL',
    delivery_status: 'QUEUED', attempt_count: 0, recipient: 'hotel@real-domain.example',
  };
  const events: any[] = [];
  let dispatchedRecipient = '';
  const prisma: any = {
    dvi_hotel_hold_notification: {
      findMany: async () => [notice],
      updateMany: async ({ data }: any) => { Object.assign(notice, data, { attempt_count: notice.attempt_count + 1 }); return { count: 1 }; },
      update: async ({ data }: any) => Object.assign(notice, data),
    },
    dvi_hotel_block_request: {
      findUnique: async () => request,
      update: async ({ data }: any) => Object.assign(request, data),
    },
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: 'DVI-TEST-49', agent_id: 7, staff_id: 8 }) },
    dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
  };
  const email: any = {
    isDispatchEnabled: () => true,
    dispatch: async ({ recipient }: any) => {
      dispatchedRecipient = recipient;
      return { status: 'SENT', recipient: 'dhisoftai@gmail.com', providerMessageId: 'test-release-49', testDelivery: true };
    },
  };
  const scheduler = new HotelHoldExpiryScheduler(prisma, email, {} as any, {} as any);

  assert.equal(await (scheduler as any).deliverNotifications(now), 1);
  assert.equal(dispatchedRecipient, 'hotel@real-domain.example');
  assert.equal(notice.delivery_status, 'SENT');
  assert.equal(notice.recipient, 'dhisoftai@gmail.com');
  assert.equal(request.release_email_status, 'PENDING');
  assert.equal(request.release_email_sent_at, null);
  assert.equal(events.some((event) => event.event_type === 'HOTEL_RELEASE_EMAIL_TEST_SENT'), true);
  assert.equal(events.some((event) => event.event_type === 'HOTEL_RELEASE_EMAIL_SENT'), false);
});

test('concurrent offline release workers record one acknowledgement-pending event', async () => {
  const { scheduler, events, requests } = createScheduler([{
    id: 43,
    itinerary_plan_id: 802,
    status: 'EXPIRED',
    paid_confirmed_at: null,
    cutoff_at: new Date('2026-11-05T11:59:00.000Z'),
    confirmation_channel: 'OFFLINE_HOLD',
    release_status: 'PENDING',
    release_email_status: 'PENDING',
  }]);
  const staleRow = { ...requests.get(43) };
  const now = new Date('2026-11-05T12:00:00.000Z');

  await Promise.all([
    (scheduler as any).releaseSupplierHold(staleRow, now),
    (scheduler as any).releaseSupplierHold(staleRow, now),
  ]);

  assert.equal(requests.get(43)?.release_status, 'REQUESTED');
  assert.equal(events.filter((event) => event.event_type === 'HOTEL_RELEASE_ACKNOWLEDGEMENT_PENDING').length, 1);
});

test('expired TBO hold with supplier already expired is acknowledged without sending another cancel', async () => {
  const calls: string[] = [];
  const prisma: any = {
    dvi_hotel_block_request: {
      updateMany: async () => ({ count: 1 }),
      update: async () => undefined,
    },
    dvi_hotel_block_event: { create: async ({ data }: any) => { calls.push(data.event_type); } },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(prisma),
  };
  const tbo: any = {
    getHoldStatus: async () => ({ status: 'Expired' }),
    cancelHeldBooking: async () => { calls.push('cancel'); return { success: true }; },
  };
  const scheduler = new HotelHoldExpiryScheduler(prisma, {} as any, {} as any, tbo);

  await (scheduler as any).releaseSupplierHold({
    id: 44, status: 'EXPIRED', release_status: 'PENDING', release_attempt_count: 0,
    confirmation_channel: 'TBO_BOOK_HOLD', confirmation_reference: 'REF-44',
    request_payload: JSON.stringify({ supplierHold: { bookingId: 441 } }),
  }, new Date('2026-11-05T12:00:00.000Z'));

  assert.equal(calls.includes('cancel'), false);
  assert.equal(calls.includes('SUPPLIER_HOLD_RELEASE_ACKNOWLEDGED'), true);
});

test('expired AxisRooms hold records a failed cancellation and retries to acknowledgement', async () => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const row: any = {
    id: 45, status: 'EXPIRED', release_status: 'PENDING', release_attempt_count: 0,
    confirmation_channel: 'AXISROOMS_HOLD', confirmation_reference: 'AX-45', hotel_code: 'AX-HOTEL-1',
    request_payload: JSON.stringify({ providerHold: { request: { confirmationNo: 'AX-45', roomStays: [{ rateId: 'RATE-45' }] } } }),
  };
  const events: any[] = [];
  const requestModel = {
    updateMany: async ({ where, data }: any) => {
      if (row.id !== where.id || row.status !== where.status) return { count: 0 };
      const allowed = where.release_status?.in || [where.release_status];
      if (where.release_status && !allowed.includes(row.release_status)) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        (row as any)[key] = value && typeof value === 'object' && 'increment' in value
          ? Number((row as any)[key] || 0) + Number((value as any).increment)
          : value;
      }
      return { count: 1 };
    },
    update: async ({ data }: any) => Object.assign(row, data),
  };
  let cancelCalls = 0;
  const prisma: any = {
    dvi_hotel_block_request: requestModel,
    dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(prisma),
  };
  const axisRooms: any = {
    cancelHeldBooking: async (request: any) => {
      cancelCalls += 1;
      assert.equal(request.confirmationNo, 'AX-45');
      return cancelCalls === 1 ? { success: false, error: 'Temporary supplier error' } : { success: true };
    },
  };
  const scheduler = new HotelHoldExpiryScheduler(prisma, {} as any, axisRooms, {} as any);

  await (scheduler as any).releaseSupplierHold({ ...row }, now);
  assert.equal(row.release_status, 'FAILED');
  assert.equal(row.release_attempt_count, 1);
  assert.equal(events.some((event) => event.event_type === 'SUPPLIER_HOLD_RELEASE_FAILED'), true);

  await (scheduler as any).releaseSupplierHold({ ...row }, new Date(now.getTime() + 6 * 60_000));
  assert.equal(cancelCalls, 2);
  assert.equal(row.release_status, 'ACKNOWLEDGED');
  assert.equal(row.release_attempt_count, 2);
  assert.equal(events.some((event) => event.event_type === 'SUPPLIER_HOLD_RELEASE_ACKNOWLEDGED'), true);
});

test('expired TBO hold cancellation failure remains retryable and does not mark release acknowledged', async () => {
  const row: any = {
    id: 46, status: 'EXPIRED', release_status: 'PENDING', release_attempt_count: 0,
    confirmation_channel: 'TBO_BOOK_HOLD', confirmation_reference: 'TBO-46',
    request_payload: JSON.stringify({ supplierHold: { bookingId: 446 } }),
  };
  const events: any[] = [];
  const prisma: any = {
    dvi_hotel_block_request: {
      updateMany: async ({ data }: any) => {
        row.release_status = data.release_status;
        row.release_attempt_count += Number(data.release_attempt_count?.increment || 0);
        return { count: 1 };
      },
      update: async ({ data }: any) => Object.assign(row, data),
    },
    dvi_hotel_block_event: { create: async ({ data }: any) => { events.push(data); } },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(prisma),
  };
  const tbo: any = {
    getHoldStatus: async () => ({ status: 'Confirmed' }),
    cancelHeldBooking: async () => { throw new Error('Cancellation pending'); },
  };
  const scheduler = new HotelHoldExpiryScheduler(prisma, {} as any, {} as any, tbo);

  await (scheduler as any).releaseSupplierHold({ ...row }, new Date('2026-11-05T12:00:00.000Z'));

  assert.equal(row.release_status, 'FAILED');
  assert.equal(row.release_last_error, 'Cancellation pending');
  assert.equal(events.some((event) => event.event_type === 'SUPPLIER_HOLD_RELEASE_FAILED'), true);
  assert.equal(events.some((event) => event.event_type === 'SUPPLIER_HOLD_RELEASE_ACKNOWLEDGED'), false);
});

test('expiry with no hotel email records manual release follow-up', async () => {
  const { scheduler, events, notices, requests } = createScheduler([{
    id: 47, itinerary_plan_id: 803, status: 'EXPIRED', paid_confirmed_at: null,
    cutoff_at: new Date('2026-11-05T11:59:00.000Z'), confirmation_channel: 'OFFLINE_HOLD',
    release_status: 'REQUESTED', release_email_status: 'PENDING', contact_email: '',
  }]);

  await (scheduler as any).enqueueNotifications({ ...requests.get(47) }, new Date('2026-11-05T12:00:00.000Z'));

  assert.equal(requests.get(47)?.release_email_status, 'MANUAL_REQUIRED');
  assert.equal(notices.find((notice) => notice.notification_type === 'HOTEL_RELEASE_EMAIL')?.delivery_status, 'MANUAL_REQUIRED');
  assert.equal(events.some((event) => event.event_type === 'HOTEL_RELEASE_MANUAL_ACTION_REQUIRED'), true);
});

test('manual cancellation uses the release worker and queues a cancellation email once', async () => {
  const { scheduler, events, notices, requests } = createScheduler([{
    id: 47, itinerary_plan_id: 803, status: 'CANCELLED', paid_confirmed_at: null,
    cutoff_at: new Date('2026-11-05T11:59:00.000Z'), confirmation_channel: 'OFFLINE_HOLD',
    release_status: 'PENDING', release_email_status: 'PENDING', version: 1,
    contact_email: 'hotel@example.test', request_payload: '{}',
  }]);

  const result = await scheduler.runOnce(new Date('2026-11-05T12:00:00.000Z'));

  assert.equal(result.expired, 0);
  assert.equal(requests.get(47)?.release_status, 'REQUESTED');
  assert.deepEqual(notices.map((notice) => [notice.notification_type, notice.milestone_key]), [['HOTEL_RELEASE_EMAIL', 'cancelled']]);
  assert.equal(events.some((event) => event.event_type === 'HOTEL_RELEASE_ACKNOWLEDGEMENT_PENDING' && event.previous_status === 'CANCELLED'), true);
});

test('hotel replacement cancellations already handled by the existing message outbox are not re-emailed', async () => {
  const { scheduler, notices } = createScheduler([{
    id: 48, itinerary_plan_id: 804, status: 'CANCELLED', paid_confirmed_at: null,
    confirmation_channel: 'TBO_BOOK_HOLD', release_status: 'NOT_REQUIRED', release_email_status: 'NOT_REQUIRED',
    contact_email: 'hotel@example.test',
  }]);

  await scheduler.runOnce(new Date('2026-11-05T12:00:00.000Z'));

  assert.equal(notices.length, 0);
});
