import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryVoucherReadService } from '../src/modules/itineraries/services/itinerary-voucher-read.service';
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

test('hotel voucher lists both saved VSR room types once across a continuous stay', async () => {
  const roomTitles = ['Superior King Room,1 King Bed', 'Deluxe Twin Room,2 Twin Beds'];
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
    itinerary_route_date: `2026-11-${26 + index}`, hotel_provider: 'tbo', hotel_code: hotelCode,
    selected_price_snapshot: index === 0 ? JSON.stringify(priceSnapshot) : priceSnapshot,
    hotel_required: 1, status: 1,
  }));
  const localHotel = {
    confirmed_itinerary_plan_hotel_details_ID: 3, itinerary_route_id: 9,
    itinerary_route_date: '2026-11-25', hotel_id: 4, hotel_provider: 'offline', hotel_code: 'LOCAL',
    selected_price_snapshot: { ...priceSnapshot, hotelName: 'Offline Hotel' }, hotel_required: 1, status: 1,
  };
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
    dvi_confirmed_itinerary_plan_hotel_voucher_details: { findMany: async () => [] },
    dvi_confirmed_itinerary_plan_hotel_cancellation_policy: { findMany: async () => [] },
    dvi_hotel: { findMany: async () => [{ hotel_id: 4, hotel_name: 'Offline Hotel' }] },
    dvi_hotel_roomtype: { findMany: async () => [{ room_type_id: 7, room_type_title: 'Premium Room' }] },
  } as any);
  service.setCallbacks({
    toDateOnly: (value) => String(value).slice(0, 10),
    getInvoiceToLabel: () => '',
    getVoucherStatusLabel: () => '',
  });

  const { hotelVoucherGroups } = await service.getVoucherDetails(1);
  assert.deepEqual(hotelVoucherGroups.find(group => group.hotelName === 'Fortune Plaza Hotel')?.roomTypes,
    [...roomTitles].sort());
  assert.deepEqual(hotelVoucherGroups.find(group => group.hotelName === 'Offline Hotel')?.roomTypes, ['Premium Room']);
});
