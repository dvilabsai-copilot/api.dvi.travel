import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryVoucherReadService } from '../src/modules/itineraries/services/itinerary-voucher-read.service';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';
import { makeTboMultiBatchStay } from '../src/modules/hotels/utils/tbo-multi-batch-stay.util';

function createService() {
  return new ItineraryVoucherReadService({
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => null },
  } as any);
}

test('voucher read preserves missing confirmed-plan validation', async () => {
  await assert.rejects(
    () => createService().getVoucherDetails(99),
    /Confirmed itinerary plan not found/,
  );
});

test('transport voucher read preserves missing confirmed-plan validation', async () => {
  await assert.rejects(
    () => createService().getTransportVoucherDetails(99),
    /Confirmed itinerary plan not found/,
  );
});

test('hotel voucher counts issued VSR batches and confirms only complete vouchered stays', async () => {
  const roomTitles = ['Deluxe Twin Room,2 Twin Beds', 'Deluxe Double Room,1 Queen Bed'];
  const hotelCode = '6437125';
  const stay = makeTboMultiBatchStay({
    hotelCode,
    roomType: roomTitles.join(' + '),
    mealPlan: 'EP',
    currency: 'INR',
    isRefundable: true,
    anchorRouteId: 10,
    routeIds: [10, 11],
    checkInDate: '2026-11-26',
    checkOutDate: '2026-11-28',
    roomCount: 8,
    dviMealSupplement: { mealPlan: 'CP', breakfastRate: 400, breakfastPerNight: 1600, dinnerRate: 0, dinnerPerNight: 0 },
    batches: [6, 2].map((roomCount, batchIndex) => ({
      hotelCode, roomType: roomTitles[batchIndex], batchIndex, startRoomIndex: batchIndex * 6, roomCount,
      bookingCode: `${hotelCode}!TB!fixture${batchIndex}`, supplierNetAmount: roomCount * 1000,
      supplierTotalFare: roomCount * 1000, currency: 'INR', isRefundable: true,
      mealPlan: batchIndex === 0 ? 'CP' : 'EP',
      occupancies: Array.from({ length: roomCount }, () => ({ adults: 2, children: 0, childrenAges: [] })),
    })),
  });
  const priceSnapshot = { hotelName: 'Fortune Plaza Hotel', tboMultiBatchStay: stay };
  const hotelRows = stay.routeIds.map((routeId, index) => ({
    confirmed_itinerary_plan_hotel_details_ID: index + 1, itinerary_route_id: routeId,
    itinerary_plan_hotel_details_ID: 101 + index, group_type: 2, hotel_cancellation_status: 0,
    itinerary_route_date: `2026-11-${26 + index}`, hotel_provider: 'tbo', hotel_code: hotelCode,
    selected_price_snapshot: index === 0 ? JSON.stringify(priceSnapshot) : priceSnapshot,
    hotel_required: 1, status: 1,
  }));
  const localHotel = {
    confirmed_itinerary_plan_hotel_details_ID: 3, itinerary_route_id: 9,
    itinerary_route_date: '2026-11-25', hotel_id: 4, hotel_provider: 'offline', hotel_code: 'LOCAL',
    selected_price_snapshot: { ...priceSnapshot, hotelName: 'Offline Hotel' }, hotel_required: 1, status: 1,
  };
  const paidAt = new Date('2026-11-25T01:00:00Z');
  const holds = stay.batches.map(batch => ({
    hotel_code: hotelCode, group_type: 2, selection_ids: '[101,102]',
    room_count: batch.roomCount, room_type: batch.roomType, meal_plan: batch.mealPlan,
    status: 'CONFIRMED', paid_confirmed_at: paidAt as Date | null, voucher_status: 'VOUCHERED',
    request_payload: JSON.stringify({ supplierHold: {
      batch: { key: 'fixture-stay', index: batch.batchIndex, count: 2 },
      bookingCode: batch.bookingCode, bookingId: 501 + batch.batchIndex,
    } }),
  }));
  let supplierRows = holds;
  const offlineVoucher = { hotel_id: 4, hotel_booking_status: 4 };
  let manualVouchers = [offlineVoucher];
  const service = new ItineraryVoucherReadService({
    dvi_confirmed_itinerary_plan_details: { findFirst: async () => ({
      confirmed_itinerary_plan_ID: 1, itinerary_preference: 1, preferred_room_count: 8,
    }) },
    dvi_confirmed_itinerary_customer_details: { findFirst: async () => null },
    dvi_confirmed_itinerary_plan_hotel_details: { findMany: async () => [...hotelRows, localHotel] },
    dvi_confirmed_itinerary_plan_hotel_room_details: { findMany: async () => [
      { confirmed_itinerary_plan_hotel_details_id: 1, room_type_id: 0 },
      { confirmed_itinerary_plan_hotel_details_id: 2, room_type_id: 0 },
      { confirmed_itinerary_plan_hotel_details_id: 3, room_type_id: 7 },
    ] },
    dvi_confirmed_itinerary_plan_hotel_voucher_details: { findMany: async () => manualVouchers },
    dvi_hotel_block_request: { findMany: async ({ where }: any) => {
      assert.deepEqual(where, { itinerary_plan_id: 1, provider: 'VSR', confirmation_channel: 'TBO_BOOK_HOLD',
        status: 'CONFIRMED', paid_confirmed_at: { not: null } });
      return supplierRows.filter(hold => hold.status === where.status && hold.paid_confirmed_at !== null);
    } },
    dvi_confirmed_itinerary_plan_hotel_cancellation_policy: { findMany: async () => [] },
    dvi_hotel: { findMany: async () => [{ hotel_id: 4, hotel_name: 'Offline Hotel' }] },
    dvi_hotel_roomtype: { findMany: async () => [{ room_type_id: 7, room_type_title: 'Premium Room' }] },
  } as any);
  service.setCallbacks({
    toDateOnly: (value) => String(value).slice(0, 10),
    getInvoiceToLabel: () => '',
    getVoucherStatusLabel: ItinerariesService.prototype['getVoucherStatusLabel'],
  });

  const { hotelVoucherGroups, summary } = await service.getVoucherDetails(1);
  assert.deepEqual(hotelVoucherGroups.find(group => group.hotelName === 'Fortune Plaza Hotel')?.roomTypes,
    [...roomTitles].sort());
  assert.deepEqual(hotelVoucherGroups.find(group => group.hotelName === 'Fortune Plaza Hotel')?.roomTypeQuantities,
    [{ roomType: roomTitles[0], roomCount: 6 }, { roomType: roomTitles[1], roomCount: 2 }]);
  const fortune = hotelVoucherGroups.find(group => group.hotelName === 'Fortune Plaza Hotel');
  assert.equal(fortune?.bookingStatusLabel, 'Confirmed');
  assert.equal(fortune?.voucherCount, 2);
  assert.equal(fortune?.hasVoucher, false);
  const offline = hotelVoucherGroups.find(group => group.hotelName === 'Offline Hotel');
  assert.deepEqual(offline?.roomTypes, ['Premium Room']);
  assert.equal(offline?.bookingStatusLabel, 'Confirmed');
  assert.equal(offline?.voucherCount, 1);
  assert.equal(offline?.hasVoucher, true);
  assert.equal(summary.existingHotelVoucherCount, 3);

  const fortuneManualVoucher = { hotel_id: 0, itinerary_plan_hotel_details_ID: 101, hotel_booking_status: 4 };
  manualVouchers = [offlineVoucher, fortuneManualVoucher];
  const withManualVoucher = await service.getVoucherDetails(1);
  assert.equal(withManualVoucher.hotelVoucherGroups.find(group => group.hotelName === 'Fortune Plaza Hotel')?.voucherCount, 3);
  assert.equal(withManualVoucher.summary.existingHotelVoucherCount, 4);
  manualVouchers = [offlineVoucher];

  supplierRows = [holds[0], { ...holds[1], voucher_status: 'PENDING' }];
  const partiallyVouchered = await service.getVoucherDetails(1);
  const partialFortune = partiallyVouchered.hotelVoucherGroups.find(group => group.hotelName === 'Fortune Plaza Hotel');
  assert.equal(partialFortune?.bookingStatusLabel, 'Not Created');
  assert.equal(partialFortune?.voucherCount, 1);
  assert.equal(partiallyVouchered.summary.existingHotelVoucherCount, 2);

  for (const invalidRows of [
    [],
    [holds[0]],
    [holds[0], { ...holds[1], paid_confirmed_at: null }],
    [holds[0], { ...holds[1], group_type: 3 }],
    [holds[0], { ...holds[1], selection_ids: '[201,202]' }],
    [holds[0], { ...holds[1], request_payload: holds[0].request_payload }],
  ]) {
    supplierRows = invalidRows;
    const result = await service.getVoucherDetails(1);
    const invalidFortune = result.hotelVoucherGroups.find(group => group.hotelName === 'Fortune Plaza Hotel');
    assert.equal(invalidFortune?.bookingStatusLabel, 'Not Created');
    assert.equal(invalidFortune?.voucherCount, 0);
    assert.equal(result.summary.existingHotelVoucherCount, 1);
  }

  supplierRows = holds;
  hotelRows[0].hotel_cancellation_status = 1;
  const cancelled = await service.getVoucherDetails(1);
  const cancelledFortune = cancelled.hotelVoucherGroups.find(group => group.hotelName === 'Fortune Plaza Hotel');
  assert.equal(cancelledFortune?.bookingStatusLabel, 'Cancelled');
  assert.equal(cancelledFortune?.voucherCount, 0);
  assert.equal(cancelled.summary.existingHotelVoucherCount, 1);
});
