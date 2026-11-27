import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryConfirmedItineraryDetailsService } from '../src/modules/itineraries/services/itinerary-confirmed-itinerary-details.service';

test('confirmed itinerary details preserves missing-plan validation', async () => {
  const service = new ItineraryConfirmedItineraryDetailsService({
    dvi_confirmed_itinerary_plan_details: {
      findUnique: async () => null,
    },
  } as any);

  await assert.rejects(
    () => service.getConfirmedItineraryDetails(99),
    /Confirmed itinerary not found/,
  );
});

test('confirmed details recover the legacy offline property rating and prefer a matching saved rating', async () => {
  const grandBaySnapshot = { provider: 'offline', canonicalHotelId: 280, category: 4 };
  const nights = [
    { hotel_id: 0, hotel_code: '280', hotel_provider: 'offline', hotel_category_id: 3 },
    { hotel_id: 0, hotel_code: '280', hotel_provider: 'offline' },
    { hotel_id: 281, hotel_code: '280', hotel_provider: 'offline', hotel_category_id: 3, snapshot: grandBaySnapshot },
    { hotel_id: 0, hotel_code: '280', hotel_provider: 'tbo' },
    { hotel_id: 0, hotel_code: '999', hotel_provider: 'offline' },
    { hotel_id: 0, hotel_code: '280.0', hotel_provider: 'offline' },
    { hotel_id: 280, hotel_code: '280', hotel_provider: 'offline', hotel_category_id: 3, snapshot: grandBaySnapshot },
    { hotel_id: 280, hotel_code: '280', hotel_provider: 'offline', hotel_category_id: 0, snapshot: grandBaySnapshot },
    { hotel_id: 0, hotel_code: '280', hotel_provider: 'offline', snapshot: { ...grandBaySnapshot, category: 5 } },
    { hotel_id: 0, hotel_code: '281', hotel_provider: 'offline', hotel_category_id: 2 },
  ];
  const localHotels = [
    { hotel_id: 280, hotel_code: '49', hotel_name: 'GRAND BAY RESORT AND SPA', hotel_category: 4 },
    { hotel_id: 281, hotel_code: '50', hotel_name: 'Hotel saved by canonical ID' },
  ];
  const date = new Date('2026-11-26T00:00:00Z');
  const empty = { findMany: async () => [] };
  const service = new ItineraryConfirmedItineraryDetailsService({
    dvi_confirmed_itinerary_plan_details: { findUnique: async () => ({ itinerary_plan_ID: 12268 }) },
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_plan_ID: 12268, itinerary_quote_ID: 'DVD2026117' }) },
    dvi_itinerary_route_details: { findMany: async () => nights.map((_, index) => ({
      itinerary_route_ID: index + 1,
      itinerary_route_date: new Date(Number(date) + index * 86_400_000),
      next_visiting_location: 'Mahabalipuram',
    })) },
    dvi_confirmed_itinerary_plan_hotel_details: { findMany: async () => nights.map((night, index) => ({
      ...night,
      itinerary_route_id: index + 1,
      group_type: 1,
      total_hotel_cost: 12285,
      selected_price_snapshot: JSON.stringify({ roomType: 'Grande Studio', mealPlan: 'CP', ...night.snapshot }),
    })) },
    dvi_confirmed_itinerary_plan_hotel_room_details: empty,
    dvi_confirmed_itinerary_plan_hotel_voucher_details: empty,
    dvi_hotel: { findMany: async ({ where }: { where: { OR: Array<{ hotel_id?: { in: number[] } }> } }) => {
      const ids = where.OR.find((condition) => condition.hotel_id)?.hotel_id?.in;
      assert.deepEqual(ids, [280, 281, 999]);
      return localHotels.filter((hotel) => ids?.includes(hotel.hotel_id));
    } },
    tbo_hotel_master: { findMany: async () => [
      { tbo_hotel_code: '280', hotel_name: 'VSR property with the same code' },
      { tbo_hotel_code: '999', hotel_name: 'Unrelated VSR property' },
    ] },
    tbo_hotel_booking_confirmation: empty,
    resavenue_hotel_booking_confirmation: empty,
    axisrooms_hotel_booking_confirmation: empty,
    staah_hotel_booking_confirmation: empty,
    hobse_hotel_booking_confirmation: empty,
  } as any);
  service.setCallbacks({ listConfirmedGuideAssignments: async () => [] });

  const result = await service.getConfirmedItineraryDetails(214);
  assert.deepEqual(result.hotels.map(({ hotelId, hotelName, provider }) => [hotelId, hotelName, provider]), [
    [280, 'GRAND BAY RESORT AND SPA', 'offline'],
    [280, 'GRAND BAY RESORT AND SPA', 'offline'],
    [281, 'Hotel saved by canonical ID', 'offline'],
    [0, 'VSR property with the same code', 'tbo'],
    [0, 'Booked hotel name missing', 'offline'],
    [0, 'Booked hotel name missing', 'offline'],
    [280, 'GRAND BAY RESORT AND SPA', 'offline'],
    [280, 'GRAND BAY RESORT AND SPA', 'offline'],
    [280, 'GRAND BAY RESORT AND SPA', 'offline'],
    [281, 'Hotel saved by canonical ID', 'offline'],
  ]);
  assert.deepEqual(result.hotels.slice(0, 2).map(({ roomType, mealPlan, totalHotelCost }) =>
    [roomType, mealPlan, totalHotelCost]), Array(2).fill(['Grande Studio', 'CP', 12285]));
  assert.deepEqual(result.hotels.map(({ category }) => category), [4, 4, 3, 0, 0, 0, 4, 4, 5, 2]);
  assert.deepEqual(await service.getConfirmedItineraryDetails(214), result);
});
