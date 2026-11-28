import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { OfflineHotelBookingDetailsDto, RespondToOfflineVoucherDto } from '../src/modules/itineraries/dto/offline-hotel-booking.dto';
import { HotelVoucherConfirmationController, OfflineHotelBookingController } from '../src/modules/itineraries/offline-hotel-booking.controller';
import { offlineHotelVoucherConfirmationUrl } from '../src/modules/itineraries/utils/offline-hotel-voucher-link';
import { readSupplierVoucherScope } from '../src/modules/itineraries/services/supplier-voucher-links';

const previousOrigin = process.env.PUBLIC_ITINERARY_BASE_URL;
const previousSupplierSecret = process.env.SUPPLIER_VOUCHER_SIGNING_SECRET;
before(() => {
  process.env.PUBLIC_ITINERARY_BASE_URL = 'https://staging.example.test';
  process.env.SUPPLIER_VOUCHER_SIGNING_SECRET = 'fixture-supplier-voucher-test-secret';
});
after(() => {
  if (previousOrigin === undefined) delete process.env.PUBLIC_ITINERARY_BASE_URL;
  else process.env.PUBLIC_ITINERARY_BASE_URL = previousOrigin;
  if (previousSupplierSecret === undefined) delete process.env.SUPPLIER_VOUCHER_SIGNING_SECRET;
  else process.env.SUPPLIER_VOUCHER_SIGNING_SECRET = previousSupplierSecret;
});

const stay = {
  routeId: 10, hotelKey: 'offline:123', checkIn: '2027-01-10', checkOut: '2027-01-12',
  hotelName: 'Tea Castle', destination: 'Munnar', version: 3,
};

const request = { user: { role: 1, userId: 12 } } as Parameters<OfflineHotelBookingController['sendVouchers']>[3];
const body = { template: 'hotel-voucher' as const, stays: [stay] };
const secondStay = { ...stay, routeId: 11, hotelKey: 'offline:456', hotelName: 'Lake Lodge' };
const statusLabels = {
  pending: 'Awaiting', waitinglist: 'Waitinglist', blocked: 'Blocked',
  confirmed: 'Confirmed', sold_out: 'Sold Out', cancelled: 'Cancelled',
};
const bookingDetails = {
  status: 'pending' as const, emails: ['hotel@example.com'], confirmedBy: '', phone: '',
  rooms: [], cancellationPolicies: [],
};

test('voucher preview preserves exact dated room rates and rejects dates outside the stay', async () => {
  const { controller } = setup();
  const fullStay = { ...stay, checkIn: '2026-12-14', checkOut: '2026-12-18' };
  const rooms = [14, 15, 16, 17].map(day => ({
    nightDate: `2026-12-${day}`, category: 'Compact A/C Room,1 Double Bed', quantity: 1,
    rate: day === 14 ? 2063.11 : 2063.10, extraBeds: 0, extraBedRate: 0, childrenWithoutBed: 0, childWithoutBedRate: 0,
  }));
  const details = plainToInstance(OfflineHotelBookingDetailsDto, { ...bookingDetails, rooms });
  assert.deepEqual(validateSync(details, { whitelist: true, forbidNonWhitelisted: true }), []);
  const { html } = await controller.previewVoucher(42, 1, { ...body, stay: fullStay, details }, request);
  assert.match(html, /Check-in<\/td><td[^>]*>14 Dec 2026/);
  assert.match(html, /Check-out<\/td><td[^>]*>18 Dec 2026/);
  assert.match(html, /14 Dec 2026<\/td>.*?2,063\.11/);
  for (const day of [15, 16, 17]) {
    assert.match(html, new RegExp(day + ' Dec 2026</td>.*?2,063\\.10'));
  }
  details.rooms[0].nightDate = fullStay.checkOut;
  await assert.rejects(controller.previewVoucher(42, 1, { ...body, stay: fullStay, details }, request), /within the hotel stay dates/);
});

function setup({
  status = 'pending', delivery = 'sent', withSecondStay = false, expertEmail,
}: {
  status?: keyof typeof statusLabels;
  delivery?: 'sent' | 'demo' | 'partial' | 'failed';
  withSecondStay?: boolean;
  expertEmail?: string;
} = {}) {
  const row = {
    route_id: stay.routeId, hotel_key: stay.hotelKey, check_in: new Date(stay.checkIn), check_out: new Date(stay.checkOut),
    details: { ...bookingDetails, status }, version: stay.version,
  };
  const secondRow = {
    ...row,
    route_id: secondStay.routeId,
    hotel_key: secondStay.hotelKey,
    details: { ...row.details, status: 'blocked' as const, emails: ['lake@example.com'] },
  };
  const rows = withSecondStay ? [row, secondRow] : [row];
  const calls: string[] = [];
  const messages: string[] = [];
  const copies: Array<string | undefined> = [];
  const prisma = {
    tbo_hotel_booking_confirmation: {
      findFirst: async () => ({ tbo_hotel_booking_confirmation_ID: 12 }),
    },
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: 'QUOTE-001', agent_id: expertEmail ? 27 : 0 }) },
    dvi_agent: { findUnique: async ({ where }: { where: object }) => {
      assert.deepEqual(where, { agent_ID: 27, deleted: 0 });
      return { travel_expert_id: 63 };
    } },
    dvi_staff_details: { findFirst: async ({ where }: { where: object }) => {
      assert.deepEqual(where, { staff_id: 63, deleted: 0 });
      return { staff_email: expertEmail };
    } },
    dvi_global_settings: { findFirst: async () => ({ site_title: 'DVi Holidays' }) },
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => ({ confirmed_itinerary_plan_ID: 5 }) },
    dvi_confirmed_itinerary_customer_details: { findFirst: async () => ({ customer_name: 'Sample Customer' }) },
    dvi_itinerary_route_details: {
      findMany: async () => rows.map((entry) => ({ itinerary_route_ID: entry.route_id, itinerary_route_date: entry.check_in })),
      findFirst: async () => ({ itinerary_route_ID: stay.routeId }),
    },
    dvi_itinerary_offline_hotel_booking: {
      findMany: async ({ where, select }: { where: object; select?: object }) => {
        if (select) assert.deepEqual(where, { itinerary_plan_id: 42, group_type: 1, details: { path: '$.status', equals: 'confirmed' } });
        return rows;
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
    dispatchOfflineVoucher: async (recipients: string[], message: { subject: string; html: string }, replyTo: unknown, scoped: boolean, cc?: string) => {
      calls.push('send');
      messages.push(message.html);
      copies.push(cc);
      assert.equal(replyTo, cc);
      const booked = rows.find((entry) => entry.details.emails[0] === recipients[0]);
      assert.ok(booked);
      assert.deepEqual(recipients, booked.details.emails);
      assert.equal(message.subject, 'DVi Holidays - Hotel Voucher of Itinerary #QUOTE-001 (Sample Customer)');
      assert.ok(message.html.includes(`Hotel Voucher - ${statusLabels[booked.details.status]}`));
      assert.equal(scoped, booked.details.status !== 'cancelled');
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
  return { controller, confirmation, calls, row, messages, copies };
}

test('Hotel Stays rejects a manual Cancelled status for an active VSR booking', async () => {
  const { controller, calls, row } = setup({ status: 'confirmed' });
  await assert.rejects(controller.save(42, 1, {
    ...stay, hotelKey: 'tbo:1001234',
    details: { ...bookingDetails, status: 'cancelled' },
  }, request), /This VSR booking is still active/);
  assert.deepEqual(calls, []);
  assert.equal(row.details.status, 'confirmed');
  assert.equal(row.version, 3);
});

test('voucher delivery uses the saved status, while Save Booking changes it and advances the version', async () => {
  const { controller, calls, row } = setup();
  const preview = await controller.previewVoucher(42, 1, { template: body.template, stay, details: bookingDetails }, request);
  assert.equal(preview.subject, 'DVi Holidays - Hotel Voucher of Itinerary #QUOTE-001 (Sample Customer)');
  assert.match(preview.html, /Hotel Voucher - Awaiting/);
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

test('the six legacy statuses are valid for booking edits and hotel responses', () => {
  const response = { reservationNumber: '', verifiedBy: 'Hotel Desk', phone: '9876543210', email: 'desk@example.com', remarks: '' };
  for (const status of Object.keys(statusLabels)) {
    assert.deepEqual(validateSync(plainToInstance(OfflineHotelBookingDetailsDto, { ...bookingDetails, status })), []);
    assert.deepEqual(validateSync(plainToInstance(RespondToOfflineVoucherDto, { ...response, status })), []);
  }
  assert.equal(validateSync(plainToInstance(OfflineHotelBookingDetailsDto, { ...bookingDetails, status: 'unknown' }))[0]?.property, 'status');
});

test('sending two vouchers uses each saved hotel status and copies the agent’s assigned expert on both', async () => {
  const { controller, calls, messages, copies } = setup({
    status: 'confirmed', withSecondStay: true, expertEmail: '  expert@example.com  ',
  });
  const { results } = await controller.sendVouchers(42, 1, { ...body, stays: [stay, secondStay] }, request);
  assert.deepEqual(results.map(({ status }) => status), ['sent', 'sent']);
  assert.deepEqual(calls, ['send', 'send']);
  assert.deepEqual(copies, ['expert@example.com', 'expert@example.com']);
  assert.match(messages[0], /Hotel Voucher - Confirmed/);
  assert.match(messages[1], /Hotel Voucher - Blocked/);
  for (const message of messages) assert.match(message, />View Voucher</);
});

test('an invalid Travel Expert email does not block delivery or become a recipient', async () => {
  const { controller, copies } = setup({ expertEmail: 'invalid' });
  const { results } = await controller.sendVouchers(42, 1, body, request);
  assert.equal(results[0].status, 'sent');
  assert.deepEqual(copies, [undefined]);
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

test('a new email uses the scoped supplier link and earlier confirmation links still work', async (t) => {
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
  assert.match(messages[0], />Confirm Book</);
  const match = messages[0].match(/https:\/\/staging\.example\.test\/supplier-voucher#token=([\w.-]+)/);
  assert.ok(match);
  assert.deepEqual(readSupplierVoucherScope(match[1]), {
    kind: 'offline-hotel', planId: 42, groupType: 1, routeId: stay.routeId, hotelKey: stay.hotelKey,
    checkIn: stay.checkIn, checkOut: stay.checkOut, version: stay.version, hotelName: stay.hotelName,
  });
  const token = offlineHotelVoucherConfirmationUrl(42, 1, stay, stay.version)?.split('/').at(-1);
  assert.ok(token);
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
