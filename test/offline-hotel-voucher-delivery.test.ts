import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelVoucherConfirmationController, OfflineHotelBookingController } from '../src/modules/itineraries/offline-hotel-booking.controller';

const stay = {
  routeId: 10, hotelKey: 'offline:123', checkIn: '2027-01-10', checkOut: '2027-01-12',
  hotelName: 'Tea Castle', destination: 'Munnar', version: 3,
};

const request = { user: { role: 1, userId: 12 } } as Parameters<OfflineHotelBookingController['sendVouchers']>[3];
const body = { template: 'hotel-voucher' as const, stays: [stay] };
const bookingDetails = {
  status: 'pending' as const, emails: ['hotel@example.com'], confirmedBy: '', phone: '',
  rooms: [], cancellationPolicies: [],
};

function setup({
  status = 'pending', delivery = 'sent',
}: {
  status?: 'pending' | 'confirmed' | 'cancelled';
  delivery?: 'sent' | 'demo' | 'partial' | 'failed';
} = {}) {
  const row = {
    route_id: stay.routeId, hotel_key: stay.hotelKey, check_in: new Date(stay.checkIn), check_out: new Date(stay.checkOut),
    details: { ...bookingDetails, status }, version: stay.version,
  };
  const calls: string[] = [];
  const messages: string[] = [];
  const prisma = {
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: 'QUOTE-001', agent_id: 0 }) },
    dvi_global_settings: { findFirst: async () => ({ site_title: 'DVi Holidays' }) },
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => ({ confirmed_itinerary_plan_ID: 5 }) },
    dvi_confirmed_itinerary_customer_details: { findFirst: async () => ({ customer_name: 'Sample Customer' }) },
    dvi_itinerary_route_details: {
      findMany: async () => [{ itinerary_route_ID: stay.routeId, itinerary_route_date: new Date(stay.checkIn) }],
      findFirst: async () => ({ itinerary_route_ID: stay.routeId }),
    },
    dvi_itinerary_offline_hotel_booking: {
      findMany: async ({ where, select }: { where: object; select?: object }) => {
        if (select) assert.deepEqual(where, { itinerary_plan_id: 42, group_type: 1, details: { path: '$.status', equals: 'confirmed' } });
        return [row];
      },
      findUnique: async () => row,
      updateMany: async ({ where, data }: { where: { version: number }; data: { details: typeof row.details } }) => {
        if (where.version !== row.version) return { count: 0 };
        calls.push('public response');
        row.details = data.details;
        row.version++;
        return { count: 1 };
      },
      update: async ({ where, data }: {
        where: { version: number };
        data: { details: typeof row.details; version: number };
      }) => {
        calls.push('save');
        assert.equal(where.version, row.version);
        row.details = data.details;
        row.version = data.version;
        return row;
      },
    },
  };
  const access = { assertCanEditPlan: async () => {}, assertCanViewPlan: async () => {} };
  const mail = {
    isDispatchEnabled: () => true,
    logFailure: () => {},
    dispatchOfflineVoucher: async (recipients: string[], message: { subject: string; html: string }) => {
      calls.push('send');
      messages.push(message.html);
      assert.deepEqual(recipients, bookingDetails.emails);
      assert.equal(message.subject, 'DVi Holidays - Hotel Voucher of Itinerary #QUOTE-001 (Sample Customer)');
      const expectedStatus = { pending: 'Pending confirmation', confirmed: 'Confirmed', cancelled: 'Cancelled' }[row.details.status];
      assert.ok(message.html.includes(`Hotel Voucher – ${expectedStatus}`));
      if (delivery === 'failed') throw new Error('SMTP rejected delivery');
      return { demo: delivery === 'demo', partial: delivery === 'partial' };
    },
  };
  const controller = new OfflineHotelBookingController(
    prisma as unknown as ConstructorParameters<typeof OfflineHotelBookingController>[0],
    access as unknown as ConstructorParameters<typeof OfflineHotelBookingController>[1],
    mail as unknown as ConstructorParameters<typeof OfflineHotelBookingController>[2],
  );
  const confirmation = new HotelVoucherConfirmationController(
    prisma as unknown as ConstructorParameters<typeof HotelVoucherConfirmationController>[0],
  );
  return { controller, confirmation, calls, row, messages };
}

test('voucher delivery uses the saved status, while Save Booking changes it and advances the version', async () => {
  const { controller, calls, row } = setup();
  const preview = await controller.previewVoucher(42, 1, { template: body.template, stay, details: bookingDetails }, request);
  assert.equal(preview.subject, 'DVi Holidays - Hotel Voucher of Itinerary #QUOTE-001 (Sample Customer)');
  assert.match(preview.html, /Hotel Voucher – Pending confirmation/);
  assert.deepEqual(calls, []);
  const { results: [result] } = await controller.sendVouchers(42, 1, body, request);
  assert.deepEqual(calls, ['send']);
  assert.equal(result.status, 'sent');
  assert.equal(row.details.status, 'pending');
  assert.equal(row.version, 3);
  const details = { ...bookingDetails, status: 'confirmed' as const, confirmedBy: 'Hotel Desk', phone: '9876543210' };
  const saved = await controller.save(42, 1, { ...stay, details }, request);
  assert.deepEqual(saved.details, details);
  assert.equal(saved.version, 4);
  await controller.sendVouchers(42, 1, { ...body, stays: [{ ...stay, version: saved.version }] }, request);
  assert.deepEqual(calls, ['send', 'save', 'send']);
  assert.equal(row.details.status, 'confirmed');
  assert.equal(row.version, 4);
});

test('the confirmation popup receives only confirmed stay identities for its quotation group', async () => {
  const { controller, calls } = setup({ status: 'confirmed' });
  const agentRequest = { user: { role: 4, agentId: 8 } } as typeof request;
  const confirmed = await controller.confirmedStays(42, 1, agentRequest);
  assert.deepEqual(confirmed, [{
    routeId: stay.routeId, hotelKey: stay.hotelKey, checkIn: stay.checkIn, checkOut: stay.checkOut,
  }]);
  assert.deepEqual(calls, []);
});

test('demo, partial and failed delivery preserve pending status, and cancelled stays stay cancelled', async () => {
  for (const delivery of ['demo', 'partial', 'failed'] as const) {
    const pending = setup({ delivery });
    const { results: [result] } = await pending.controller.sendVouchers(42, 1, body, request);
    assert.equal(result.status, delivery);
    assert.deepEqual(pending.calls, ['send']);
    assert.equal(pending.row.details.status, 'pending');
  }
  const cancelled = setup({ status: 'cancelled' });
  const { results: [result] } = await cancelled.controller.sendVouchers(42, 1, body, request);
  assert.equal(result.status, 'sent');
  assert.deepEqual(cancelled.calls, ['send']);
  assert.equal(cancelled.row.details.status, 'cancelled');
});

test('a stale voucher version is skipped without sending or saving', async () => {
  const { controller, calls } = setup();
  const { results: [result] } = await controller.sendVouchers(42, 1, { ...body, stays: [{ ...stay, version: 2 }] }, request);
  assert.equal(result.status, 'skipped');
  assert.match(result.message ?? '', /booking details changed/i);
  assert.deepEqual(calls, []);
});

test('a stay confirmed by voucher can be edited with its existing blank contact fields', async () => {
  const { controller } = setup({ status: 'confirmed' });
  const details = { ...bookingDetails, status: 'confirmed' as const };
  const saved = await controller.save(42, 1, { ...stay, details }, request);
  assert.equal(saved.version, 4);
  await assert.rejects(setup().controller.save(42, 1, { ...stay, details }, request), /Enter the confirmer/);
});

test('the emailed confirmation link reads the stay without changing it, and records one explicit response', async (t) => {
  t.mock.method(Date, 'now', () => new Date('2026-11-23T10:00:00Z').getTime());
  const previousOrigin = process.env.PUBLIC_ITINERARY_BASE_URL;
  const previousSecret = process.env.JWT_SECRET;
  process.env.PUBLIC_ITINERARY_BASE_URL = 'https://staging.example.test';
  process.env.JWT_SECRET = 'voucher-test-signing-secret';
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.PUBLIC_ITINERARY_BASE_URL;
    else process.env.PUBLIC_ITINERARY_BASE_URL = previousOrigin;
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  const { controller, confirmation, row, calls, messages } = setup();
  await controller.sendVouchers(42, 1, body, request);
  assert.match(messages[0], /confirm the hotel reservation/);
  const match = messages[0].match(/https:\/\/staging\.example\.test\/hotel\/voucher-confirmation\/([\w.-]+)/);
  assert.ok(match);
  const token = match[1];
  assert.deepEqual(await confirmation.get(token), {
    quote: 'QUOTE-001', hotelName: stay.hotelName, checkIn: stay.checkIn, checkOut: stay.checkOut, status: 'pending',
  });
  assert.deepEqual(calls, ['send']);
  await assert.rejects(confirmation.get(`x${token}`), /unavailable/);
  const response = {
    status: 'confirmed' as const, reservationNumber: '', verifiedBy: 'Hotel Desk',
    phone: '9876543210', email: 'desk@example.com', remarks: 'Room ready',
  };
  await assert.rejects(confirmation.respond(token, response), /reservation number/);
  assert.equal(row.details.status, 'pending');
  assert.equal(row.version, 3);
  assert.deepEqual(await confirmation.respond(token, { ...response, reservationNumber: 'QA-123' }), { status: 'confirmed' });
  assert.equal(row.details.status, 'confirmed');
  assert.deepEqual(row.details.emails, bookingDetails.emails);
  assert.equal(row.version, 4);
  await assert.rejects(confirmation.get(token), /unavailable/);
  assert.deepEqual(calls, ['send', 'public response']);
});
