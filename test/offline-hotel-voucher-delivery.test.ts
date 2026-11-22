import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { OfflineHotelBookingController } from '../src/modules/itineraries/offline-hotel-booking.controller';

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
  status = 'pending', delivery = 'sent', changedDuringSend = false,
}: {
  status?: 'pending' | 'confirmed' | 'cancelled';
  delivery?: 'sent' | 'demo' | 'partial' | 'failed';
  changedDuringSend?: boolean;
} = {}) {
  const row = {
    route_id: stay.routeId, hotel_key: stay.hotelKey, check_in: new Date(stay.checkIn), check_out: new Date(stay.checkOut),
    details: { ...bookingDetails, status }, version: stay.version,
  };
  const calls: string[] = [];
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
      findMany: async () => [row],
      findUnique: async () => row,
      update: async ({ where, data }: {
        where: { version: number };
        data: { details: typeof row.details; version: number | { increment: number } };
      }) => {
        calls.push('save');
        assert.equal(where.version, row.version);
        if (changedDuringSend) throw new Prisma.PrismaClientKnownRequestError('Stale version', { code: 'P2025', clientVersion: 'test' });
        row.details = data.details;
        row.version = typeof data.version === 'number' ? data.version : row.version + data.version.increment;
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
      assert.deepEqual(recipients, bookingDetails.emails);
      assert.equal(message.subject, 'DVi Holidays - Hotel Voucher of Itinerary #QUOTE-001 (Sample Customer)');
      assert.match(message.html, status === 'cancelled' ? /Hotel Voucher – Cancelled/ : /Hotel Voucher – Confirmed/);
      if (delivery === 'failed') throw new Error('SMTP rejected delivery');
      return { demo: delivery === 'demo', partial: delivery === 'partial' };
    },
  };
  const controller = new OfflineHotelBookingController(
    prisma as unknown as ConstructorParameters<typeof OfflineHotelBookingController>[0],
    access as unknown as ConstructorParameters<typeof OfflineHotelBookingController>[1],
    mail as unknown as ConstructorParameters<typeof OfflineHotelBookingController>[2],
  );
  return { controller, calls, row };
}

test('live voucher delivery confirms the stay and returns the next version', async () => {
  const { controller, calls, row } = setup();
  const preview = await controller.previewVoucher(42, 1, { template: body.template, stay, details: bookingDetails }, request);
  assert.equal(preview.subject, 'DVi Holidays - Hotel Voucher of Itinerary #QUOTE-001 (Sample Customer)');
  assert.deepEqual(calls, []);
  const { results: [result] } = await controller.sendVouchers(42, 1, body, request);
  assert.deepEqual(calls, ['send', 'save']);
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.confirmedBooking?.details, { ...bookingDetails, status: 'confirmed' });
  assert.equal(result.confirmedBooking?.version, 4);
  assert.equal(row.details.status, 'confirmed');
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

test('a change during delivery is reported without overwriting the stay or retrying email', async () => {
  const { controller, calls } = setup({ changedDuringSend: true });
  const { results: [result] } = await controller.sendVouchers(42, 1, body, request);
  assert.equal(result.status, 'sent');
  assert.equal(result.confirmedBooking, undefined);
  assert.match(result.message ?? '', /stay changed during delivery/i);
  assert.deepEqual(calls, ['send', 'save']);
});

test('a stay confirmed by voucher can be edited with its existing blank contact fields', async () => {
  const { controller } = setup({ status: 'confirmed' });
  const details = { ...bookingDetails, status: 'confirmed' as const };
  const saved = await controller.save(42, 1, { ...stay, details }, request);
  assert.equal(saved.version, 4);
  await assert.rejects(setup().controller.save(42, 1, { ...stay, details }, request), /Enter the confirmer/);
});
