import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { readSupplierVoucherScope, supplierVoucherLink, voucherRecipientHash } from '../src/modules/itineraries/services/supplier-voucher-links';
import { SupplierVoucherService } from '../src/modules/itineraries/services/supplier-voucher.service';
import { ItinerariesController } from '../src/modules/itineraries/itineraries.controller';
import { ItineraryBookingConfirmationEmailNotifierService } from '../src/modules/itineraries/services/itinerary-booking-confirmation-email-notifier.service';

const secret = 'supplier-voucher-test-secret-not-used-in-production';
process.env.SUPPLIER_VOUCHER_SIGNING_SECRET = secret;
process.env.PUBLIC_ITINERARY_BASE_URL = 'https://vouchers.example';

const tokenFrom = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('token')!;
const hotel = {
  kind: 'offline-hotel' as const, planId: 42, groupType: 1, routeId: 5, hotelKey: 'offline:24',
  checkIn: '2027-02-02', checkOut: '2027-02-03', version: 1, hotelName: 'Fixture hotel',
};
const vehicle = { kind: 'vehicle' as const, planId: 42, voucherId: 27, version: 1 };
const provider = {
  kind: 'provider-hotel' as const, planId: 42, hotelId: 24, stayIds: [9], recipientHash: voucherRecipientHash('hotel@example.com'),
};

function setup() {
  let version = 1;
  let vehicleVersion = 1;
  let vehicleStatus = 1;
  let cancelled = false;
  let revision: { status: string; superseded_at: Date | null } | null = null;
  let providerRows = [
    { hotel_check_in_date: new Date(hotel.checkIn), hotel_check_out_date: new Date(hotel.checkOut), total_no_of_rooms: 2, hotel_provider: ' VSR ' },
  ];
  let masterEmail = 'hotel@example.com';
  let details = {
    status: 'pending', confirmedBy: '', phone: '', emails: ['hotel@example.com'],
    hotelResponse: undefined as Record<string, string> | undefined,
    rooms: [{ category: 'Superior', quantity: 2, rate: 5000 }], cancellationPolicies: [],
  };
  const emails: Array<{ recipients: string[]; subject: string; html: string; scoped: boolean }> = [];
  const prisma = {
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => ({ itinerary_quote_ID: 'Q-42' }) },
    dvi_cancelled_itineraries: { findFirst: async () => cancelled ? { cancelled_itinerary_ID: 31 } : null },
    dvi_itinerary_quote_revision: { findUnique: async () => revision },
    dvi_itinerary_route_details: { findFirst: async () => ({ itinerary_route_ID: hotel.routeId }) },
    dvi_itinerary_offline_hotel_booking: {
      findFirst: async ({ where }: any) => {
        assert.deepEqual(where, {
          itinerary_plan_id: 42, group_type: 1, route_id: 5, hotel_key: 'offline:24',
          check_in: new Date(hotel.checkIn), check_out: new Date(hotel.checkOut), version: 1,
        });
        return where.version === version ? { details } : null;
      },
      updateMany: async ({ where, data }: any) => {
        if (where.version !== version) return { count: 0 };
        version++;
        details = data.details;
        return { count: 1 };
      },
    },
    dvi_confirmed_itinerary_plan_vehicle_voucher_details: {
      findFirst: async ({ where }: any) => {
        if (where.itinerary_plan_id !== 42 || where.cnf_itinerary_plan_vehicle_voucher_details_ID !== 27 ||
            !where.vehicle_booking_status.in.includes(vehicleStatus) ||
            (where.supplier_confirmation_version !== undefined && where.supplier_confirmation_version !== vehicleVersion)) {
          return null;
        }
        return { supplier_confirmation_version: vehicleVersion, vendor_id: 2, vehicle_type_id: 3,
          vehicle_booking_status: vehicleStatus, vehicle_confirmed_email_id: 'supplier@example.com' };
      },
      updateMany: async ({ where, data }: any) => {
        if (where.supplier_confirmation_version !== vehicleVersion || !where.vehicle_booking_status.in.includes(vehicleStatus)) return { count: 0 };
        assert.equal(where.itinerary_plan_id, 42);
        assert.equal(where.cnf_itinerary_plan_vehicle_voucher_details_ID, 27);
        vehicleVersion++;
        vehicleStatus = data.vehicle_booking_status;
        return { count: 1 };
      },
    },
    dvi_vendor_details: { findFirst: async () => ({ vendor_name: 'Fixture transport' }) },
    dvi_vehicle_type: { findFirst: async () => ({ vehicle_type_title: 'Sedan' }) },
    dvi_hotel: { findFirst: async () => ({ hotel_name: 'Fixture hotel', hotel_email: masterEmail }) },
    dvi_confirmed_itinerary_plan_hotel_details: { findMany: async ({ where }: any) => {
      assert.equal(where.itinerary_plan_id, 42);
      assert.equal(where.hotel_id, 24);
      assert.deepEqual(where.confirmed_itinerary_plan_hotel_details_ID.in, [9]);
      assert.equal(where.hotel_cancellation_status, 0);
      return providerRows;
    } },
  };
  const transport = {
    isDispatchEnabled: () => true,
    dispatchOfflineVoucher: async (recipients: string[], message: { subject: string; html: string }, _replyTo: unknown, scoped: boolean) => {
      emails.push({ recipients, ...message, scoped });
      return { demo: false, partial: false };
    },
  };
  return {
    service: new SupplierVoucherService(prisma as never, transport as never),
    emails,
    get hotelDetails() { return details; },
    get vehicleStatus() { return vehicleStatus; },
    setHotelStatus: (status: string) => { details = { ...details, status }; },
    supersede: () => { revision = { status: 'READY', superseded_at: new Date() }; },
    cancel: () => { cancelled = true; },
    cancelVehicle: () => { vehicleStatus = 6; },
    removeProviderStay: () => { providerRows = []; },
    removeProviderRecipient: () => { masterEmail = 'replacement@example.com'; },
  };
}

test('voucher tokens expire and reject tampering', () => {
  const url = supplierVoucherLink(hotel);
  assert.equal(new URL(url).pathname, '/supplier-voucher');
  const token = tokenFrom(url);
  assert.deepEqual(readSupplierVoucherScope(token), hotel);
  const [payload, signature] = token.split('.');
  const alteredPayload = Buffer.from(JSON.stringify({ scope: { ...hotel, planId: 43 }, expires: 3_000_000_000 })).toString('base64url');
  assert.throws(() => readSupplierVoucherScope(alteredPayload + '.' + signature), /invalid, expired/);
  const expiredPayload = Buffer.from(JSON.stringify({ scope: hotel, expires: 1 })).toString('base64url');
  const expiredSignature = createHmac('sha256', secret).update('supplier-voucher:v1:' + expiredPayload).digest('base64url');
  assert.throws(() => readSupplierVoucherScope(expiredPayload + '.' + expiredSignature), /invalid, expired/);
  assert.throws(() => readSupplierVoucherScope(payload), /invalid, expired/);
});

test('offline hotel confirmation updates the scoped stay once and preserves saved recipient data', async () => {
  const fixture = setup();
  const token = tokenFrom(supplierVoucherLink(hotel));
  const voucher = await fixture.service.open(token);
  assert.equal(voucher.reference, 'Q-42');
  assert.equal(voucher.canConfirm, true);
  assert.equal('emails' in voucher, false);
  const contact = { token, confirmedBy: 'Fixture contact', phone: '9876543210' };
  await assert.rejects(fixture.service.confirm(contact), /reservation number/);
  await assert.rejects(fixture.service.confirm({ ...contact, reservationNo: 'H-42' }), /hotel email/);
  const input = { ...contact, reservationNo: 'H-42', email: 'reservations@example.com', remarks: 'Late arrival' };
  const outcomes = await Promise.allSettled([fixture.service.confirm(input), fixture.service.confirm(input)]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(fixture.hotelDetails.status, 'confirmed');
  assert.deepEqual(fixture.hotelDetails.emails, ['hotel@example.com']);
  assert.equal(fixture.hotelDetails.phone, '');
  assert.equal(fixture.hotelDetails.confirmedBy, '');
  const { submittedAt, ...response } = fixture.hotelDetails.hotelResponse!;
  assert.ok(Number.isFinite(Date.parse(submittedAt)));
  assert.deepEqual(response, {
    status: 'confirmed', reservationNumber: 'H-42', verifiedBy: 'Fixture contact',
    phone: '9876543210', email: 'reservations@example.com', remarks: 'Late arrival',
  });
  await assert.rejects(() => fixture.service.open(token), /invalid, expired/);
});

test('vehicle email uses only the saved recipient and confirmation consumes the voucher version', async () => {
  const fixture = setup();
  assert.deepEqual(await fixture.service.sendVehicleVoucher(42, 27), { status: 'sent' });
  assert.equal(fixture.vehicleStatus, 1);
  assert.equal(fixture.emails.length, 1);
  assert.deepEqual(fixture.emails[0].recipients, ['supplier@example.com']);
  assert.equal(fixture.emails[0].scoped, true);
  assert.match(fixture.emails[0].html, />Confirm Book</);
  const token = fixture.emails[0].html.match(/#token=([^"]+)"/)![1];
  assert.deepEqual(readSupplierVoucherScope(token), vehicle);
  assert.equal((await fixture.service.open(token)).canConfirm, true);
  await assert.rejects(() => fixture.service.confirm({ token, confirmedBy: 'Fixture', phone: '9876543210' }), /reservation number/);
  await fixture.service.confirm({ token, confirmedBy: 'Fixture', phone: '9876543210', reservationNo: 'X27' });
  assert.equal(fixture.vehicleStatus, 4);
  await assert.rejects(() => fixture.service.open(token), /invalid, expired/);
  await assert.rejects(() => fixture.service.sendVehicleVoucher(43, 27), /invalid, expired/);
});

test('non-pending hotel statuses remain viewable until cancelled or superseded', async () => {
  const fixture = setup();
  const token = tokenFrom(supplierVoucherLink(hotel));
  for (const status of ['waitinglist', 'blocked', 'confirmed', 'sold_out']) {
    fixture.setHotelStatus(status);
    const result = await fixture.service.open(token);
    assert.equal(result.status, status);
    assert.equal(result.canConfirm, false);
    await assert.rejects(fixture.service.confirm({ token, confirmedBy: 'Fixture', phone: '9876543210' }), /invalid, expired/);
  }
  fixture.setHotelStatus('cancelled');
  await assert.rejects(fixture.service.open(token), /invalid, expired/);
  fixture.setHotelStatus('pending');
  fixture.supersede();
  await assert.rejects(fixture.service.open(token), /invalid, expired/);
});

test('cancelled vouchers, partial cancellations, and revoked provider recipients cannot open or confirm', async () => {
  const fixture = setup();
  const vehicleToken = tokenFrom(supplierVoucherLink(vehicle));
  fixture.cancelVehicle();
  await assert.rejects(() => fixture.service.open(vehicleToken), /invalid, expired/);
  const providerToken = tokenFrom(supplierVoucherLink(provider));
  assert.equal((await fixture.service.open(providerToken)).canConfirm, false);
  await assert.rejects(() => fixture.service.confirm({ token: providerToken, confirmedBy: 'Fixture', phone: '9876543210' }), /invalid, expired/);
  fixture.removeProviderRecipient();
  await assert.rejects(() => fixture.service.open(providerToken), /invalid, expired/);
  fixture.removeProviderStay();
  await assert.rejects(() => fixture.service.open(providerToken), /invalid, expired/);
  fixture.cancel();
  await assert.rejects(() => fixture.service.open(tokenFrom(supplierVoucherLink(hotel))), /invalid, expired/);
});

test('combined voucher endpoints authorize before reading itinerary data or generating PDFs', async () => {
  const calls: string[] = [];
  const allowed = Object.assign(Object.create(ItinerariesController.prototype), {
    itineraryAccessService: { assertCanViewPlan: async (id: number, viewer: { userId: number }) => {
      calls.push('check ' + id + ' / ' + viewer.userId);
      if (viewer.userId !== 7) throw new Error('Forbidden');
    } },
    svc: { getVoucherDetails: async () => { calls.push('details'); return {}; } },
    itineraryPdfService: { downloadVoucherPdf: async () => { calls.push('pdf'); } },
  }) as ItinerariesController;
  await assert.rejects(() => allowed.getVoucherDetails(42, { user: { userId: 8 } } as never), /Forbidden/);
  await assert.rejects(() => allowed.downloadVoucherPdf(42, {} as never, { user: { userId: 8 } } as never), /Forbidden/);
  assert.deepEqual(calls, ['check 42 / 8', 'check 42 / 8']);
  await allowed.getVoucherDetails(42, { user: { userId: 7 } } as never);
  await allowed.downloadVoucherPdf(42, {} as never, { user: { userId: 7 } } as never);
  assert.deepEqual(calls.slice(2), ['check 42 / 7', 'details', 'check 42 / 7', 'pdf']);
});

test('confirmed hotels receive separate signed links and only the agent and internal recipients receive the combined PDF', async (t) => {
  t.mock.method(console, 'log', () => {});
  const previousAdmin = process.env.BOOKING_CONFIRMATION_ADMIN_EMAILS;
  const previousOps = process.env.BOOKING_CONFIRMATION_OPS_EMAILS;
  const previousTestInbox = process.env.BOOKING_CONFIRMATION_MAIL_TEST_RECIPIENT;
  process.env.BOOKING_CONFIRMATION_ADMIN_EMAILS = 'admin@example.com';
  process.env.BOOKING_CONFIRMATION_OPS_EMAILS = 'operations@example.com';
  delete process.env.BOOKING_CONFIRMATION_MAIL_TEST_RECIPIENT;
  t.after(() => {
    if (previousAdmin === undefined) delete process.env.BOOKING_CONFIRMATION_ADMIN_EMAILS;
    else process.env.BOOKING_CONFIRMATION_ADMIN_EMAILS = previousAdmin;
    if (previousOps === undefined) delete process.env.BOOKING_CONFIRMATION_OPS_EMAILS;
    else process.env.BOOKING_CONFIRMATION_OPS_EMAILS = previousOps;
    if (previousTestInbox === undefined) delete process.env.BOOKING_CONFIRMATION_MAIL_TEST_RECIPIENT;
    else process.env.BOOKING_CONFIRMATION_MAIL_TEST_RECIPIENT = previousTestInbox;
  });
  const messages: Array<{ to: string | string[]; cc?: string[]; bcc?: string; text: string; html: string; attachments?: Array<{ content: Buffer }> }> = [];
  const pdf = Buffer.from('%PDF-1.4 fixture');
  const notifier = new ItineraryBookingConfirmationEmailNotifierService({
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => ({
      itinerary_plan_ID: 42, itinerary_quote_ID: 'Q-42', itinerary_preference: 3, agent_id: 2,
    }) },
    dvi_confirmed_itinerary_plan_hotel_details: { findMany: async ({ where }: any) => {
      assert.deepEqual(where, { itinerary_plan_id: 42, status: 1, deleted: 0, hotel_cancellation_status: 0 });
      return [
        { hotel_id: 24, confirmed_itinerary_plan_hotel_details_ID: 9, hotel_provider: 'tbo' },
        { hotel_id: 25, confirmed_itinerary_plan_hotel_details_ID: 12, hotel_provider: 'axisrooms' },
      ];
    } },
    dvi_hotel: { findMany: async () => [
      { hotel_id: 24, hotel_name: 'Hotel A', hotel_email: 'a@example.com' },
      { hotel_id: 25, hotel_name: 'Hotel B', hotel_email: 'b@example.com' },
    ] },
    dvi_agent: { findFirst: async () => ({ agent_email_id: 'agent@example.com', travel_expert_id: 1 }) },
    dvi_staff_details: { findFirst: async () => ({ staff_email: 'expert@example.com' }) },
    dvi_global_settings: { findFirst: async () => ({
      company_email_id: 'sender@example.com', cc_email_id: 'accounts@example.com',
    }) },
  } as never, { get: () => ({
    createVoucherPdfBuffer: async (id: number, kind: string) => {
      assert.equal(id, 42);
      assert.equal(kind, 'all');
      return pdf;
    },
  }) } as never);
  (notifier as any).getTransporter = () => ({ sendMail: async (message: typeof messages[number]) => messages.push(message) });
  await notifier.sendBookingConfirmationNotifications(42);
  assert.equal(messages.length, 3);
  for (const [i, recipient, hotelId, stayIds] of [[0, 'a@example.com', 24, [9]], [1, 'b@example.com', 25, [12]]] as const) {
    const message = messages[i];
    assert.equal(message.to, recipient);
    assert.equal(message.cc, undefined);
    assert.equal(message.bcc, undefined);
    assert.equal(message.attachments, undefined);
    assert.match(message.html, />View Voucher</);
    const url = message.text.match(/https:\/\/vouchers\.example\/supplier-voucher#token=[\w.-]+/)?.[0];
    assert.ok(url);
    assert.deepEqual(readSupplierVoucherScope(tokenFrom(url)), {
      kind: 'provider-hotel', planId: 42, hotelId, stayIds, recipientHash: voucherRecipientHash(recipient),
    });
  }
  const combined = messages[2];
  assert.deepEqual(combined.to, ['agent@example.com']);
  assert.deepEqual(new Set(combined.cc), new Set(['admin@example.com', 'accounts@example.com', 'expert@example.com', 'operations@example.com']));
  assert.equal(combined.bcc, undefined);
  assert.deepEqual(combined.attachments?.[0]?.content, pdf);
  assert.match(combined.text, /https:\/\/vouchers\.example\/pdf-preview\/voucher\/42/);

  messages.length = 0;
  process.env.BOOKING_CONFIRMATION_MAIL_TEST_RECIPIENT = 'qa@example.com';
  await notifier.sendBookingConfirmationNotifications(42);
  assert.equal(messages.length, 3);
  for (const message of messages) {
    assert.equal(message.to, 'qa@example.com');
    assert.equal(message.cc, undefined);
    assert.equal(message.bcc, undefined);
  }
  assert.match(messages[0].html, />View Voucher</);
  assert.match(messages[1].html, />View Voucher</);
  assert.deepEqual(messages[2].attachments?.[0]?.content, pdf);

  messages.length = 0;
  process.env.BOOKING_CONFIRMATION_MAIL_TEST_RECIPIENT = 'qa@example.com,other@example.com';
  await notifier.sendBookingConfirmationNotifications(42);
  assert.equal(messages.length, 0);
});
