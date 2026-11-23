import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';

const booking = {
  provider: 'vsr', routeId: 10, routeIds: [10, 11], hotelCode: '123', hotelName: 'Tea Castle',
  roomType: 'Executive Room', checkInDate: '2027-01-10', checkOutDate: '2027-01-12',
  netAmount: 17940.53, prebookContext: { bookingCode: 'stale!TB!test' },
};

function setup(prebook: () => Promise<unknown>) {
  const calls: string[] = [];
  const service = Object.create(ItinerariesService.prototype) as any;
  const dates = ['2027-01-10', '2027-01-11'];
  Object.assign(service, {
    prisma: {
      dvi_itinerary_plan_hotel_details: { findMany: async () => [{
        itinerary_route_id: 10, hotel_code: '123', total_no_of_rooms: 2, total_room_cost: 8543.11,
        selected_price_snapshot: JSON.stringify({
          tboRoomNightBreakdown: dates.flatMap((date) => [4271.55, 4271.56].map((allInAmount, index) => ({ date, allInAmount, roomNumber: index + 1 }))),
          selectedTotalPrice: 17940.53, hotelMarginAmount: 854.31,
        }),
      }] },
    },
    confirmationService: {
      mergeConsecutiveSupplierHotelBookings: (rows: unknown[]) => rows,
      pruneHotelBookingsCoveredByMultiNight: (rows: unknown[]) => rows,
      getProviderBookableHotelBookings: (rows: unknown[]) => rows,
      getConfirmHotelGroupType: () => 3,
      confirmQuotation: async () => { calls.push('confirm'); return { success: false }; },
    },
    hotelConfirmationSupportService: {
      filterAlreadySuccessfulBookings: async (_planId: number, rows: unknown[]) => ({ pendingBookings: rows }),
    },
    hotelPrebookService: {
      prebookHotels: async (payload: { hotel_bookings: { netAmount: number }[] }) => {
        calls.push('prebook');
        assert.equal(payload.hotel_bookings[0].netAmount, 17086.22);
        return prebook();
      },
    },
  });
  return { service, calls, dto: { itinerary_plan_ID: 1, hotel_bookings: [{ ...booking }] } };
}

const offer = (amount: number | null) => ({ hotels: [{ routeId: 10, hotelCode: '123', prebookContext: {
  bookingCode: 'fresh!TB!test', prebookNetAmount: amount,
} }] });

test('Confirm & Pay calls fresh VSR PreBook and uses its code when the saved supplier fare matches', async () => {
  const { service, calls, dto } = setup(async () => offer(17086.22));
  await service.confirmQuotation(dto);
  assert.deepEqual(calls, ['prebook', 'confirm']);
  assert.equal(dto.hotel_bookings[0].provider, 'tbo');
  assert.equal(dto.hotel_bookings[0].prebookContext.bookingCode, 'fresh!TB!test');
  assert.equal(dto.hotel_bookings[0].netAmount, 17940.53);
});

test('Confirm & Pay blocks a changed VSR rate before confirmation and rechecks every retry', async () => {
  let fare = 17500;
  const { service, calls, dto } = setup(async () => offer(fare));
  for (const currentFare of [17500, 18000]) {
    fare = currentFare;
    await assert.rejects(() => service.confirmQuotation(dto), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.deepEqual((error.getResponse() as any).reviews, [{ routeId: 10, hotelName: 'Tea Castle', previousAmount: 17086.22, newAmount: currentFare }]);
      return true;
    });
  }
  assert.deepEqual(calls, ['prebook', 'prebook']);
  assert.equal(dto.hotel_bookings[0].netAmount, 17940.53);
});

test('Confirm & Pay stops before confirmation when VSR is unavailable or cannot verify the rate', async () => {
  const unavailable = new BadRequestException({ code: 'VSR_HOTEL_UNAVAILABLE', message: 'Hotel is not available for the selected stay.' });
  const rejected = setup(async () => { throw unavailable; });
  await assert.rejects(() => rejected.service.confirmQuotation(rejected.dto), (error) => error === unavailable);
  assert.deepEqual(rejected.calls, ['prebook']);
  const missingFare = setup(async () => offer(null));
  await assert.rejects(() => missingFare.service.confirmQuotation(missingFare.dto), /did not verify a bookable rate/);
  assert.deepEqual(missingFare.calls, ['prebook']);
});

test('Confirm & Pay leaves active hold and hotel-free confirmation paths alone', async () => {
  const { service, calls, dto } = setup(async () => { throw new Error('unexpected PreBook'); });
  await service.confirmQuotation({ ...dto, manualHotelHoldWorkflow: true });
  await service.confirmQuotation({ ...dto, hotel_bookings: [] });
  assert.deepEqual(calls, ['confirm', 'confirm']);
});
