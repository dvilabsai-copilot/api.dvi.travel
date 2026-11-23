import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';

const booking = {
  provider: 'vsr', routeId: 10, routeIds: [10, 11], hotelCode: '123', hotelName: 'Tea Castle',
  roomType: 'Executive Room', checkInDate: '2027-01-10', checkOutDate: '2027-01-12',
  bookingCode: '123!TB!2!TB!original', mealPlan: 'MAP', guestNationality: 'IN',
  netAmount: 17940.53, prebookContext: { bookingCode: 'stale!TB!test' },
};

function setup(prebook: (selection: { bookingCode: string; routeId: number }) => Promise<unknown>) {
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
          roomType: 'Executive Room', mealPlan: 'MAP', tboMapFallbackSourceMealPlan: 'CP', isRefundable: true,
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
      prebookHotels: async (payload: { hotel_bookings: { netAmount: number; bookingCode: string; routeId: number }[] }) => {
        calls.push('prebook');
        assert.equal(payload.hotel_bookings[0].netAmount, 17086.22);
        return prebook(payload.hotel_bookings[0]);
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

const refreshedRate = {
  hotelCode: '123', roomType: 'Executive Room', mealPlan: 'CP', isRefundable: true,
  bookingCode: '123!TB!2!TB!refreshed', supplierSearchCompletedAt: new Date().toISOString(),
};
const expired = new BadRequestException({ code: 'VSR_PREBOOK_SESSION_EXPIRED', message: 'Session expired' });

test('Confirm & Pay refreshes the full stay after supplier session expiry and reports its changed price', async () => {
  const check = setup(async (selection) => {
    if (selection.bookingCode === booking.bookingCode) throw expired;
    assert.equal(selection.bookingCode, refreshedRate.bookingCode);
    return offer(17500);
  });
  check.service.hotelDetailsTboService = { searchSelectedHotelForContinuousStay: async (params: unknown) => {
    check.calls.push('search');
    assert.deepEqual(params, {
      planId: 1, routeIds: [10, 11], provider: 'tbo', hotelCode: '123',
      checkInDate: booking.checkInDate, checkOutDate: booking.checkOutDate,
      vsrConfirmationRefresh: { guestNationality: 'IN' },
    });
    return [{ ...refreshedRate, mealPlan: 'MAP' }, refreshedRate];
  } };
  await assert.rejects(() => check.service.confirmQuotation(check.dto), (error: ConflictException) =>
    (error.getResponse() as any).code === 'VSR_RATE_CHANGED' && (error.getResponse() as any).reviews[0].newAmount === 17500,
  );
  assert.deepEqual(check.calls, ['prebook', 'search', 'prebook']);
  assert.deepEqual(check.dto.hotel_bookings, [booking]);
});

test('a known expired timestamp refreshes before PreBook and preserves the priced selection identity', async () => {
  const check = setup(async (selection) => {
    assert.equal(selection.bookingCode, refreshedRate.bookingCode);
    return offer(17086.22);
  });
  check.service.hotelDetailsTboService = { searchSelectedHotelForContinuousStay: async () => {
    check.calls.push('search');
    return [refreshedRate];
  } };
  const stale = { ...booking, searchInitiatedAt: '2026-01-01T10:00:00Z' };
  const dto = { ...check.dto, hotel_bookings: [stale] };
  await check.service.confirmQuotation(dto);
  assert.deepEqual(check.calls, ['search', 'prebook', 'confirm']);
  assert.equal(dto.hotel_bookings[0].bookingCode, stale.bookingCode);
  assert.equal(dto.hotel_bookings[0].searchInitiatedAt, refreshedRate.supplierSearchCompletedAt);
  assert.equal(dto.hotel_bookings[0].prebookContext.bookingCode, 'fresh!TB!test');
  assert.equal(dto.hotel_bookings[0].netAmount, booking.netAmount);
});

test('an expired VSR offer cannot switch to a different room or meal plan', async () => {
  const check = setup(async () => { throw expired; });
  check.service.hotelDetailsTboService = { searchSelectedHotelForContinuousStay: async () => [
    { ...refreshedRate, roomType: 'Deluxe Room' }, { ...refreshedRate, mealPlan: 'EP' },
  ] };
  await assert.rejects(() => check.service.confirmQuotation(check.dto), (error: BadRequestException) =>
    (error.getResponse() as any).code === 'VSR_HOTEL_UNAVAILABLE',
  );
  assert.deepEqual(check.calls, ['prebook']);
});

test('a VSR balance error blocks confirmation and leaves another stay rate visible', async () => {
  const balance = new BadRequestException({
    code: 'VSR_PREBOOK_INSUFFICIENT_BALANCE', message: 'PreBook failed: Insufficient Balance.',
  });
  const check = setup(async (selection) => {
    if (selection.routeId === 12) throw balance;
    return offer(17500);
  });
  const findMany = check.service.prisma.dvi_itinerary_plan_hotel_details.findMany;
  check.service.prisma.dvi_itinerary_plan_hotel_details.findMany = async () => {
    const [row] = await findMany();
    return [row, { ...row, itinerary_route_id: 12, hotel_code: '456' }];
  };
  check.dto.hotel_bookings.unshift({ ...booking, routeId: 12, routeIds: [12, 13], hotelCode: '456', hotelName: 'Westwood' });
  await assert.rejects(() => check.service.confirmQuotation(check.dto), (error: ConflictException) => {
    const response = error.getResponse() as any;
    assert.equal(response.code, 'VSR_RATE_CHANGED');
    assert.match(response.message, /insufficient balance for Westwood/i);
    assert.equal(response.reviews[0].hotelName, 'Tea Castle');
    return true;
  });
  assert.deepEqual(check.calls, ['prebook', 'prebook']);
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
