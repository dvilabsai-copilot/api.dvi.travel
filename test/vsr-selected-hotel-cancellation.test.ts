import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelVoucherService } from '../src/modules/itineraries/hotel-voucher.service';
import { TboHotelBookingService } from '../src/modules/itineraries/services/tbo-hotel-booking.service';

const hotel = {
  itinerary_plan_hotel_details_ID: 7, itinerary_route_id: 5, status: 1,
  hotel_required: 1, hotel_id: 10, hotel_code: '1001234', hotel_provider: 'tbo', hotel_booking_mode: 'LIVE_API',
};
const supplierRow = {
  itinerary_route_ID: 5, tbo_hotel_booking_confirmation_ID: 6, tbo_hotel_code: hotel.hotel_code,
  tbo_booking_reference_number: 'VSR-REF', tbo_booking_id: '42', status: 1, api_response: null,
};

function setup() {
  const writes: string[] = [];
  const supplierCalls: string[] = [];
  let rejected = true;
  const log = (name: string) => async () => { writes.push(name); return { cnf_itinerary_plan_hotel_voucher_details_ID: 9 }; };
  const db = {
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
    tbo_hotel_booking_confirmation: {
      findMany: async ({ where }: any) => {
        assert.equal(where.itinerary_plan_ID, 100);
        if (where.OR) assert.deepEqual(where.OR, [{ itinerary_route_ID: 5, tbo_hotel_code: '1001234' }]);
        return [supplierRow];
      },
      update: log('supplier status'),
    },
    dvi_itinerary_plan_hotel_details: {
      findMany: async ({ where }: any) => {
        assert.deepEqual(where.itinerary_plan_hotel_details_ID, { in: [7] });
        assert.equal(where.itinerary_route_id, undefined);
        return [hotel];
      },
      updateMany: log('planned hotel'),
    },
    dvi_confirmed_itinerary_plan_hotel_details: { findMany: async () => [hotel], updateMany: log('confirmed hotel') },
    dvi_confirmed_itinerary_plan_hotel_voucher_details: {
      create: log('create cancelled voucher'),
      update: log('cancel voucher'),
      updateMany: log('cancel voucher'),
    },
  };
  const tbo = new TboHotelBookingService(db as never, null as never, {
    cancelBooking: async (id: string) => {
      supplierCalls.push(id);
      if (rejected) throw new Error('Supplier rejected cancellation');
      return { cancellationRef: 'FIXTURE', refundAmount: 0, charges: 0 };
    },
  } as never, null as never);
  const otherProvider = {
    cancelItineraryHotelsByRoutes: log('other provider'),
    cancelVoucherHotel: log('other provider'),
  };
  const service = new HotelVoucherService(
    db as never, tbo, otherProvider as never, otherProvider as never, otherProvider as never, otherProvider as never,
    { assertSelectionsCanCreateVoucher: async () => {} } as never,
  );
  return { service, writes, supplierCalls, confirm: () => { rejected = false; } };
}

test('the hotel cancellation endpoint scopes VSR to the selected property and leaves it active on rejection', async () => {
  const { service, writes, supplierCalls, confirm } = setup();
  const cancel = () => service.cancelHotelsForItinerary(100, { reason: 'QA', route_ids: [5], hotel_details_ids: [7] });
  await assert.rejects(cancel(), /VSR did not confirm/);
  assert.deepEqual(supplierCalls, ['42']);
  assert.deepEqual(writes, []);
  confirm();
  assert.equal((await cancel()).data.cancelledHotels, 1);
  assert.deepEqual(writes, ['supplier status', 'planned hotel', 'confirmed hotel', 'cancel voucher']);
});

test('saving a cancelled hotel voucher cannot write a voucher before VSR confirms it', async () => {
  const { service, writes, supplierCalls } = setup();
  await assert.rejects(service.createHotelVouchers({
    itineraryPlanId: 100,
    vouchers: [{
      routeId: 5, hotelId: 10, hotelDetailsIds: [7], routeDates: ['2027-01-10'],
      confirmedBy: '', emailId: '', mobileNumber: '', status: 'cancelled', invoiceTo: '', voucherTermsCondition: '',
    }],
  }), /VSR did not confirm/);
  assert.deepEqual(supplierCalls, ['42']);
  assert.deepEqual(writes, []);
});
